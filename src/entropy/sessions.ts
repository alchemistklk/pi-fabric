// On-demand session measurement. Session JSONL is the source of truth, so
// entropy is never recorded: the newest project sessions are read live,
// measured against the current surface, and the trend is the per-session
// slope. The repair table stays the only durable derived artifact because
// it is the only one that changes runtime behavior.

import fs from "node:fs";
import path from "node:path";
import { sessionDirForCwd } from "../memory/discovery.js";
import { entropyTracesFromSessionJsonl } from "./corpus.js";
import { measureEntropy } from "./meter.js";
import { trendFromScores } from "./fingerprint.js";
import type { EntropyReport, EntropySurfaceSnapshot, EntropyTrend } from "./types.js";

const DEFAULT_SESSION_WINDOW = 8;

export interface SessionCorpusEntry {
  file: string;
  operations: number;
  report: EntropyReport;
}

export interface SessionCorpusResult {
  files: readonly string[];
  sessions: SessionCorpusEntry[];
  latest?: EntropyReport;
  trend: EntropyTrend;
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
  return {
    files: input.files,
    sessions,
    ...(sessions.length > 0 ? { latest: sessions[0]!.report } : {}),
    trend: trendFromScores(chronological.map((session) => session.report.score)),
  };
};
