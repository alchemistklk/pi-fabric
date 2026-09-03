// The compiled entropy surface: the durable artifact the autonomous
// compiler maintains beside the repair table. Every overlay entry records
// the digest of the live schema it was compiled against, and every consult
// re-proves that digest against the live declared schema — an entry whose
// base changed underneath it drops out instead of mis-enforcing. The
// artifact is clock-free and deterministic: the same evidence compiles to
// the same bytes.

import { Value } from "typebox/value";
import { stableJsonHash } from "../core/stable-hash.js";
import type { EntropyProposal, EntropySurfaceSnapshot, EntropyTraceInput } from "./types.js";

export const COMPILED_SURFACE_VERSION = 1 as const;
export const MAX_COMPILED_SURFACE_PROPOSALS = 256;

export interface CompiledSurfaceOverlayEntry {
  ref: string;
  inputSchema: Record<string, unknown>;
  baseSchemaDigest: string;
}

export interface CompiledSurfaceQuarantineEntry {
  ref: string;
  baseSchemaDigest: string;
}

export interface CompiledSurfaceAppliedProposal {
  kind: EntropyProposal["kind"];
  ref: string;
  detail: string;
}

export interface CompiledSurfaceGateRecord {
  passed: boolean;
  beforeScore: number;
  afterScore: number;
  reasons: string[];
}

export interface CompiledSurfaceFile {
  version: typeof COMPILED_SURFACE_VERSION;
  metricVersion: number;
  actions: CompiledSurfaceOverlayEntry[];
  quarantined: CompiledSurfaceQuarantineEntry[];
  applied: CompiledSurfaceAppliedProposal[];
  gate: CompiledSurfaceGateRecord;
  evidenceDigest: string;
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const schemaDigest = (schema: unknown): string => stableJsonHash(schema);

// Overlay consult for one ref: the compiled schema replaces the declared
// schema only while the base digest still proves the declared surface did
// not change underneath the compile.
export const effectiveSchemaFor = (
  ref: string,
  liveSchema: unknown,
  file?: CompiledSurfaceFile,
): unknown => {
  const entry = file?.actions.find((candidate) => candidate.ref === ref);
  if (!entry) return liveSchema;
  return schemaDigest(liveSchema) === entry.baseSchemaDigest ? entry.inputSchema : liveSchema;
};

// Whole-surface overlay for measurement and export: tightened schemas where
// the base still matches, quarantined refs hidden where the base still
// matches. Stale entries fall back to the live surface, never mis-enforce.
export const applyCompiledSurface = (
  live: EntropySurfaceSnapshot,
  file?: CompiledSurfaceFile,
): EntropySurfaceSnapshot => {
  if (!file || (file.actions.length === 0 && file.quarantined.length === 0)) return live;
  const byRef = new Map<string, unknown>(
    live.actions.map((action) => [action.ref, action.inputSchema]),
  );
  const overlayByRef = new Map(file.actions.map((entry) => [entry.ref, entry]));
  const quarantineByRef = new Map(file.quarantined.map((entry) => [entry.ref, entry]));
  const actions: EntropySurfaceSnapshot["actions"] = [];
  for (const action of live.actions) {
    const overlay = overlayByRef.get(action.ref);
    if (overlay && schemaDigest(byRef.get(action.ref)) === overlay.baseSchemaDigest) {
      actions.push({ ref: action.ref, inputSchema: overlay.inputSchema });
      continue;
    }
    const quarantine = quarantineByRef.get(action.ref);
    if (quarantine && schemaDigest(byRef.get(action.ref)) === quarantine.baseSchemaDigest) {
      continue;
    }
    actions.push(action);
  }
  return { version: 1, actions };
};

// Name-only quarantine view for catalog filtering: hiding there is
// advisory, so no digest proof is required. Resolution denial is the
// digested isQuarantinedRef below.
export const quarantinedRefNames = (file?: CompiledSurfaceFile): ReadonlySet<string> =>
  new Set(file?.quarantined.map((entry) => entry.ref));

// Resolution denial with digest proof: a quarantined ref stays callable
// only when the live schema changed underneath the compile.
export const isQuarantinedRef = (
  ref: string,
  liveSchema: unknown,
  file?: CompiledSurfaceFile,
): boolean => {
  const entry = file?.quarantined.find((candidate) => candidate.ref === ref);
  if (!entry) return false;
  return schemaDigest(liveSchema) === entry.baseSchemaDigest;
};

export interface ReplayViolation {
  ref: string;
  reason: string;
}

// Replay preservation: every successful call to a ref the compile touched
// must still parse against the candidate surface — resolution plus the same
// TypeBox check the registry's validate stage uses. Untouched refs keep
// their schema by identity, so replay stays scoped to the touched set.
export const replaySuccessfulCalls = (
  surface: EntropySurfaceSnapshot,
  traces: readonly EntropyTraceInput[],
  touchedRefs: ReadonlySet<string>,
): ReplayViolation[] => {
  const schemaByRef = new Map(surface.actions.map((action) => [action.ref, action.inputSchema]));
  const violations: ReplayViolation[] = [];
  for (const sourceTrace of traces) {
    for (const operation of sourceTrace.operations) {
      if (operation.outcome !== "succeeded") continue;
      if (operation.ref.startsWith("fabric.")) continue;
      if (!touchedRefs.has(operation.ref)) continue;
      const schema = schemaByRef.get(operation.ref);
      if (schema === undefined) {
        violations.push({ ref: operation.ref, reason: "absent from the candidate surface" });
        continue;
      }
      let valid = false;
      try {
        valid = isPlainRecord(schema) && Value.Check(schema, operation.args);
      } catch {
        valid = false;
      }
      if (!valid) {
        violations.push({
          ref: operation.ref,
          reason: "recorded arguments no longer validate against the compiled schema",
        });
      }
    }
  }
  return violations;
};