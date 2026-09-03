// Corpus shaping for the entropy meter: turn persisted Fabric execution
// traces and session JSONL into meter traces, and normalize catalog repair
// rows. Only guarded, typed records are consumed — never rendered prose.

import { readFabricExecutionTraceV1, type FabricExecutionTraceV1 } from "../audit/trace.js";
import { stableJsonHash } from "../core/stable-hash.js";
import type { CatalogRepair } from "../repairs/types.js";
import type {
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
export const entropyTraceFromFabricTrace = (trace: FabricExecutionTraceV1): EntropyTraceInput => ({
  operations: trace.operations.map((operation) => ({
    ref: operation.ref,
    args: operation.args,
    outcome: operation.outcome,
    ...(operation.failureStage !== undefined ? { failureStage: operation.failureStage } : {}),
  })),
  taskKey: trace.phases[0] ?? DEFAULT_TASK_KEY,
});

const sessionDetailsRecords = (lines: readonly string[]): Record<string, unknown>[] => {
  const records: Record<string, unknown>[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const details = isRecord(parsed.details)
      ? parsed.details
      : isRecord(parsed.message) && isRecord(parsed.message.details)
        ? parsed.message.details
        : undefined;
    if (isRecord(details)) records.push(details);
  }
  return records;
};

// Extract meter traces from Pi session JSONL lines. Malformed lines, non-trace
// entries, and envelopes that fail the trace guard are skipped without
// throwing; only typed, guarded trace V1 envelopes count.
export const entropyTracesFromSessionJsonl = (lines: readonly string[]): EntropyTraceInput[] => {
  const traces: EntropyTraceInput[] = [];
  for (const details of sessionDetailsRecords(lines)) {
    const trace = readFabricExecutionTraceV1(details.trace);
    if (trace) traces.push(entropyTraceFromFabricTrace(trace));
  }
  return traces;
};

// Verbatim audit arguments are the authoritative value corpus for
// enum-tighten: trace V1 projects values away per ref (external and MCP calls
// keep none), while persisted audits carry every argument the call used. The
// observations stay local to the session record, exactly like the audits.
export const entropyValueObservationsFromSessionJsonl = (
  lines: readonly string[],
): EntropyValueObservation[] => {
  const observations: EntropyValueObservation[] = [];
  for (const details of sessionDetailsRecords(lines)) {
    if (!Array.isArray(details.audits)) continue;
    for (const audit of details.audits) {
      if (!isRecord(audit)) continue;
      const ref = typeof audit.ref === "string" ? audit.ref : undefined;
      const args = isRecord(audit.args) ? audit.args : undefined;
      if (!ref || !args) continue;
      for (const [key, value] of Object.entries(args)) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          observations.push({ ref, key, value });
        }
      }
    }
  }
  return observations;
};

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
