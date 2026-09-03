// Deterministic tool-entropy measurement for the Fabric tool surface.
//
// Entropy here is operational, not psychological: it counts the bits of
// corrective freedom a surface leaves open, measured only from artifacts
// Fabric already records in typed form (trace V1 operations, the repair
// table, live JSON schemas). No model judges anything; the same inputs and
// the same metric version always produce the same report.

export const ENTROPY_METRIC_VERSION = 1 as const;
export const ENTROPY_LEDGER_VERSION = 1 as const;
export const MAX_ENTROPY_LEDGER_ENTRIES = 256 as const;

// Fixed weights per metric version. Changing any weight bumps
// ENTROPY_METRIC_VERSION so ledger trends never mix formulas.
export const ENTROPY_WEIGHTS = {
  shape: 1,
  failureStage: 1,
  churn: 4,
  navigation: 4,
  flow: 1,
  lexicon: 2,
  staticFreedom: 0.25,
} as const;

// Failure stages that mean "the surface rejected the call before it could
// take effect" — the offline residue class behind repair fingerprints.
export const ENTROPY_INVOCATION_STAGES: readonly string[] = ["resolve", "prepare", "validate"];

export type EntropyOutcome = "succeeded" | "failed" | "aborted" | "timed_out";

export interface EntropySurfaceAction {
  ref: string;
  inputSchema: unknown;
}

export interface EntropySurfaceSnapshot {
  version: 1;
  actions: EntropySurfaceAction[];
}

export interface EntropyOperationInput {
  ref: string;
  args: Record<string, unknown>;
  outcome: EntropyOutcome;
  failureStage?: string;
}

export interface EntropyTraceInput {
  operations: EntropyOperationInput[];
  taskKey?: string;
}

// Normalized catalog-repair row: `ref` is the target the row repairs toward.
export interface EntropyRepairRowInput {
  kind: "keyAlias" | "actionAlias";
  ref: string;
  from: string;
  to: string;
}

// One verbatim argument value observed in persisted audits: the value-level
// corpus for enum-tighten. Trace V1 projects values away per ref; audits
// carry every argument the call actually used.
export interface EntropyValueObservation {
  ref: string;
  key: string;
  value: string | number | boolean;
}

export interface EntropyShapeSignature {
  signature: string;
  count: number;
}

export interface EntropyRefReport {
  ref: string;
  calls: number;
  succeeded: number;
  failed: number;
  shapeSignatures: EntropyShapeSignature[];
  shapeEntropyBits: number;
  failureStageEntropyBits: number;
  churnRate: number;
  lexiconRows: number;
  staticFreedom: number;
  score: number;
}

export interface EntropyTotals {
  traces: number;
  operations: number;
  actionOperations: number;
  discoveryOperations: number;
  workflowOperations: number;
  succeeded: number;
  failed: number;
  aborted: number;
  timedOut: number;
  invocationRejections: number;
  invocationRejectionsPer1k: number;
}

export interface EntropyReport {
  metricVersion: typeof ENTROPY_METRIC_VERSION;
  catalogDigest: string;
  totals: EntropyTotals;
  shapeEntropyBits: number;
  failureStageEntropyBits: number;
  churnRate: number;
  navigationRatio: number;
  flowEntropyBits: number;
  lexiconRows: number;
  staticFreedom: number;
  score: number;
  refs: EntropyRefReport[];
}

export type EntropyProposal =
  | {
      kind: "enum-tighten";
      ref: string;
      key: string;
      values: (string | number | boolean)[];
      calls: number;
      distinct: number;
      topShare: number;
    }
  | {
      kind: "overload-split";
      ref: string;
      shapeEntropyBits: number;
      clusters: { keys: string[]; calls: number }[];
    }
  | {
      kind: "sequence-fuse";
      sequence: string[];
      occurrences: number;
    }
  | {
      kind: "noise-quarantine";
      ref: string;
      calls: number;
      succeeded: number;
      failed: number;
      failureStageEntropyBits: number;
    }
  | {
      kind: "modal-rename";
      level: "key" | "action";
      ref: string;
      from: string;
      to: string;
      note: string;
    };

export interface EntropyGateResult {
  passed: boolean;
  beforeScore: number;
  afterScore: number;
  delta: number;
  reasons: string[];
}

export interface EntropyLedgerEntry {
  catalogDigest: string;
  metricVersion: number;
  score: number;
  operations: number;
  invocationRejectionsPer1k: number;
  source: string;
  createdAt: string;
}

export interface EntropyLedgerFile {
  version: typeof ENTROPY_LEDGER_VERSION;
  entries: EntropyLedgerEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface EntropyTrend {
  count: number;
  firstScore?: number;
  lastScore?: number;
  slopePerEntry: number;
}
