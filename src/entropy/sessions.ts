// On-demand session measurement. Session JSONL is the source of truth, so
// entropy is never recorded: the newest machine sessions are read live
// across every project under the agent dir, measured against the current
// surface, and the trend is the per-session slope. Evidence breadth matches
// enforcement breadth: the compiled surface governs the whole machine, so
// it learns from the whole machine. The repair table and the compiled
// entropy surface are the only durable derived artifacts, because they are
// the only ones that change runtime behavior.

import fs from "node:fs";
import path from "node:path";
import { sessionDirForCwd, sessionsDirRoot } from "../memory/discovery.js";
import {
  entropySessionEvidenceFromJsonl,
  entropyTracesFromSessionJsonl,
} from "./corpus.js";
import { measureEntropy } from "./meter.js";
import { compareCodeUnits, trendFromScores } from "./fingerprint.js";
import type {
  EntropyAuditCall,
  EntropyModelReport,
  EntropyReport,
  EntropySurfaceSnapshot,
  EntropyTraceInput,
  EntropyTrend,
  EntropyValueObservation,
} from "./types.js";

const DEFAULT_SESSION_WINDOW = 8;

export interface SessionCorpusEntry {
  file: string;
  operations: number;
  report: EntropyReport;
}

// Per-model trend across the session window: the attribution that names
// which model's behavior moved, with the surface share staying global.
export interface SessionModelTrend {
  model: string;
  sessions: number;
  latestBehavioralScore: number;
  slopePerSession: number;
  latestRejectionsPer1k: number;
}

export interface SessionCorpusResult {
  files: readonly string[];
  sessions: SessionCorpusEntry[];
  latest?: EntropyReport;
  trend: EntropyTrend;
  models: SessionModelTrend[];
}

// Newest-first session JSONL files for one project cwd, bounded by `limit`.
// Mtime ties break by path so the ordering is stable.
export const projectSessionFiles = (
  agentDir: string,
  cwd: string,
  limit = DEFAULT_SESSION_WINDOW,
): string[] => {
  const dir = sessionDirForCwd(cwd, agentDir);
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const stamped = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => {
      const file = path.join(dir, entry.name);
      let mtime = 0;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        mtime = 0;
      }
      return { file, mtime };
    });
  stamped.sort(
    (left, right) =>
      right.mtime - left.mtime || (left.file < right.file ? -1 : left.file > right.file ? 1 : 0),
  );
  return stamped.slice(0, Math.max(1, limit)).map((entry) => entry.file);
};

// Machine-wide session window: newest sessions across every project under
// the agent dir, bounded by `limit` in total. The current project's newest
// session is always included even when quieter projects would crowd it
// out, because the live session produced this turn's evidence. Ordering
// matches projectSessionFiles: mtime descending, path tiebreak, stable.
export const machineSessionFiles = (
  agentDir: string,
  cwd: string | undefined,
  limit = DEFAULT_SESSION_WINDOW,
): string[] => {
  const root = sessionsDirRoot(agentDir);
  let projectDirs: fs.Dirent[] = [];
  try {
    projectDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const byNewest = (
    left: { file: string; mtime: number },
    right: { file: string; mtime: number },
  ) =>
    right.mtime - left.mtime ||
    (left.file < right.file ? -1 : left.file > right.file ? 1 : 0);
  const stamped: { file: string; mtime: number }[] = [];
  const directories = projectDirs
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const directory of directories) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(path.join(root, directory.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.filter(
      (candidate) => candidate.isFile() && candidate.name.endsWith(".jsonl"),
    )) {
      const file = path.join(root, directory.name, entry.name);
      let mtime = 0;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        mtime = 0;
      }
      stamped.push({ file, mtime });
    }
  }
  stamped.sort(byNewest);
  const window = Math.max(1, limit);
  let selected = stamped.slice(0, window);
  if (cwd) {
    const current = projectSessionFiles(agentDir, cwd, 1)[0];
    if (current !== undefined && !selected.some((entry) => entry.file === current)) {
      const kept = [...selected];
      if (kept.length >= window) kept.length = window - 1;
      let mtime = 0;
      try {
        mtime = fs.statSync(current).mtimeMs;
      } catch {
        mtime = 0;
      }
      kept.push({ file: current, mtime });
      kept.sort(byNewest);
      selected = kept;
    }
  }
  return selected.map((entry) => entry.file);
};

// Measure each session file independently against the same surface; sessions
// without fabric_exec traces contribute nothing. `files` must be newest
// first; the trend runs oldest to newest.
export const measureSessionCorpus = (input: {
  files: readonly string[];
  surface?: EntropySurfaceSnapshot;
  catalogDigest?: string;
}): SessionCorpusResult => {
  const sessions: SessionCorpusEntry[] = [];
  for (const file of input.files) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const traces = entropyTracesFromSessionJsonl(text.split("\n"));
    if (traces.length === 0) continue;
    const report = measureEntropy({
      traces,
      ...(input.surface ? { surface: input.surface } : {}),
      ...(input.catalogDigest !== undefined ? { catalogDigest: input.catalogDigest } : {}),
    });
    if (report.totals.operations === 0) continue;
    sessions.push({ file, operations: report.totals.operations, report });
  }
  const chronological = [...sessions].reverse();
  const modelScores = new Map<string, { behavioral: number[]; latest: EntropyModelReport }>();
  for (const session of chronological) {
    for (const model of session.report.byModel) {
      const entry = modelScores.get(model.model) ?? { behavioral: [], latest: model };
      entry.behavioral.push(model.behavioralScore);
      entry.latest = model;
      modelScores.set(model.model, entry);
    }
  }
  const models: SessionModelTrend[] = [...modelScores.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([model, entry]) => ({
      model,
      sessions: entry.behavioral.length,
      latestBehavioralScore: entry.latest.behavioralScore,
      slopePerSession: trendFromScores(entry.behavioral).slopePerStep,
      latestRejectionsPer1k: entry.latest.invocationRejectionsPer1k,
    }));
  return {
    files: input.files,
    sessions,
    ...(sessions.length > 0 ? { latest: sessions[0]!.report } : {}),
    trend: trendFromScores(chronological.map((session) => session.report.score)),
    models,
  };
};

// One read per file yields the meter traces, the verbatim audit value
// corpus, the verbatim audit calls, and the per-file observation windows
// the machine-wide pool consumes with exact deltas, so the autonomous
// compile and the command share a single window scan.
export interface SessionObservationWindow {
  file: string;
  observations: EntropyValueObservation[];
}

export interface SessionWindowEvidence {
  traces: EntropyTraceInput[];
  valueObservations: EntropyValueObservation[];
  auditCalls: EntropyAuditCall[];
  observationWindows: SessionObservationWindow[];
}

export const sessionWindowEvidence = (
  files: readonly string[],
): SessionWindowEvidence => {
  const traces: EntropyTraceInput[] = [];
  const valueObservations: EntropyValueObservation[] = [];
  const auditCalls: EntropyAuditCall[] = [];
  const observationWindows: SessionObservationWindow[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const evidence = entropySessionEvidenceFromJsonl(text.split("\n"));
    traces.push(...evidence.traces);
    valueObservations.push(...evidence.valueObservations);
    auditCalls.push(...evidence.auditCalls);
    observationWindows.push({ file, observations: evidence.valueObservations });
  }
  return { traces, valueObservations, auditCalls, observationWindows };
};
