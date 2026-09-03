// Corpus shaping for the entropy meter: turn persisted Fabric execution
// traces and session JSONL into meter traces, and normalize catalog repair
// rows. Only guarded, typed records are consumed — never rendered prose.

import {
  FABRIC_EXECUTION_TRACE_KIND,
  readFabricExecutionTraceV1,
  type FabricExecutionTraceV1,
} from "../audit/trace.js";
import { stableJsonHash } from "../core/stable-hash.js";
import type { CatalogRepair } from "../repairs/types.js";
import type {
  EntropyAuditCall,
  EntropyReport,
  EntropyRepairRowInput,
  EntropyTraceInput,
  EntropyValueObservation,
} from "./types.js";

const DEFAULT_TASK_KEY = "(none)";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// One Fabric execution trace becomes one meter trace. The first persisted
// workflow phase is the deterministic task key for flow entropy.
export const entropyTraceFromFabricTrace = (
  trace: FabricExecutionTraceV1,
  model?: string,
): EntropyTraceInput => ({
  operations: trace.operations.map((operation) => ({
    ref: operation.ref,
    args: operation.args,
    outcome: operation.outcome,
    ...(operation.failureStage !== undefined ? { failureStage: operation.failureStage } : {}),
  })),
  taskKey: trace.phases[0] ?? DEFAULT_TASK_KEY,
  ...(model ? { model } : {}),
});

const MODEL_CHANGE_FILTER = '"type":"model_change"';
const ASSISTANT_FILTER = '"role":"assistant"';

// Model identity for one parsed session record: `model_change` entries name
// the provider/model from that point on, and assistant messages carry the
// provider/model that produced the turn. A toolResult's producing model is
// the one active at its line, so the scan tracks it in order.
const modelFromRecord = (parsed: Record<string, unknown>): string | undefined => {
  if (parsed.type === "model_change") {
    const provider = typeof parsed.provider === "string" ? parsed.provider : "";
    const modelId = typeof parsed.modelId === "string" ? parsed.modelId : "";
    return provider && modelId ? `${provider}/${modelId}` : undefined;
  }
  const message = isRecord(parsed.message) ? parsed.message : undefined;
  if (!message || message.role !== "assistant") return undefined;
  const provider = typeof message.provider === "string" ? message.provider : "";
  const modelId = typeof message.model === "string" ? message.model : "";
  return provider && modelId ? `${provider}/${modelId}` : undefined;
};

interface ScannedSessionRecord {
  details: Record<string, unknown>;
  model?: string;
}

// Cheap pre-filters keep on-demand multi-session scans fast on large logs:
// only lines that can carry a trace envelope or a model identity get parsed.
// The substring gates are lossy by design; the guarded parse decides.
const sessionRecords = (lines: readonly string[]): ScannedSessionRecord[] => {
  const records: ScannedSessionRecord[] = [];
  let currentModel: string | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const traceLine = trimmed.includes(FABRIC_EXECUTION_TRACE_KIND);
    const modelLine =
      !traceLine &&
      (trimmed.includes(MODEL_CHANGE_FILTER) || trimmed.includes(ASSISTANT_FILTER));
    if (!traceLine && !modelLine) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    if (modelLine) {
      const model = modelFromRecord(parsed);
      if (model) currentModel = model;
      continue;
    }
    const details = isRecord(parsed.details)
      ? parsed.details
      : isRecord(parsed.message) && isRecord(parsed.message.details)
        ? parsed.message.details
        : undefined;
    if (isRecord(details)) {
      records.push({ details, ...(currentModel ? { model: currentModel } : {}) });
    }
  }
  return records;
};

// One scan of the session records yields all three evidence corpora: meter
// traces, the verbatim audit value corpus, and the verbatim audit calls
// themselves. The extractors below stay thin so every caller keeps its
// public shape.
export interface EntropySessionEvidence {
  traces: EntropyTraceInput[];
  valueObservations: EntropyValueObservation[];
  auditCalls: EntropyAuditCall[];
}

export const entropySessionEvidenceFromJsonl = (
  lines: readonly string[],
): EntropySessionEvidence => {
  const traces: EntropyTraceInput[] = [];
  const valueObservations: EntropyValueObservation[] = [];
  const auditCalls: EntropyAuditCall[] = [];
  for (const record of sessionRecords(lines)) {
    const trace = readFabricExecutionTraceV1(record.details.trace);
    if (trace) traces.push(entropyTraceFromFabricTrace(trace, record.model));
    const details = record.details;
    if (!Array.isArray(details.audits)) continue;
    for (const audit of details.audits) {
      if (!isRecord(audit)) continue;
      const ref = typeof audit.ref === "string" ? audit.ref : undefined;
      const args = isRecord(audit.args) ? audit.args : undefined;
      if (!ref || !args) continue;
      auditCalls.push({ ref, args });
      for (const [key, value] of Object.entries(args)) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          valueObservations.push({ ref, key, value });
        }
      }
    }
  }
  return { traces, valueObservations, auditCalls };
};

// Extract meter traces from Pi session JSONL lines. Malformed lines, non-trace
// entries, and envelopes that fail the trace guard are skipped without
// throwing; only typed, guarded trace V1 envelopes count.
export const entropyTracesFromSessionJsonl = (lines: readonly string[]): EntropyTraceInput[] =>
  entropySessionEvidenceFromJsonl(lines).traces;

// Verbatim audit arguments are the authoritative value corpus for
// enum-tighten. The observations stay local to the session record, exactly
// like the audits.
export const entropyValueObservationsFromSessionJsonl = (
  lines: readonly string[],
): EntropyValueObservation[] => entropySessionEvidenceFromJsonl(lines).valueObservations;

// One verbatim call per persisted audit: the authoritative replay corpus.
// Trace V1 projects values away per ref (external and MCP calls keep none),
// so replay validation consults these whenever a touched ref has them.
export const entropyAuditCallsFromSessionJsonl = (
  lines: readonly string[],
): EntropyAuditCall[] => entropySessionEvidenceFromJsonl(lines).auditCalls;

// Normalize catalog repair rows for the meter. `ref` is the target the row
// repairs toward: the declared key's action for key aliases, or
// provider.declared-action for action aliases.
export const entropyRepairRows = (repairs: readonly CatalogRepair[]): EntropyRepairRowInput[] =>
  repairs.map((repair) =>
    repair.kind === "keyAlias"
      ? { kind: "keyAlias", ref: repair.ref, from: repair.from, to: repair.to }
      : {
          kind: "actionAlias",
          ref: `${repair.provider}.${repair.to}`,
          from: repair.from,
          to: repair.to,
        },
  );

// Stable hash of a report — the determinism check compares these.
export const entropyReportHash = (report: EntropyReport): string => stableJsonHash(report);
