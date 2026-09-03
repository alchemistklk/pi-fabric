// The autonomous compile step: measure → propose → apply the mechanical
// subset → re-measure → gate. The gate proves two things on the retained
// corpus: the score never increases, and every successful call to a ref
// the compile touched still parses against the candidate surface.
// Overload-split and sequence-fuse author new composite definitions, and a
// pure modal rename drops the declared key that every successful call
// recorded, so all three stay surfaced for review and never auto-apply.
// enum-tighten only ever tightens beneath a declared enum (the
// closed-domain rule), so the auto loop subtracts freedom the schema
// already claimed and never invents a domain: open vocabularies arrive as
// declare-enum review signals instead.

import { stableJsonHash } from "../core/stable-hash.js";
import { measureEntropy } from "./meter.js";
import { applyProposalsToSurface, evaluateGate, proposeEntropyReductions } from "./passes.js";
import {
  COMPILED_SURFACE_VERSION,
  MAX_COMPILED_SURFACE_PROPOSALS,
  applyCompiledSurface,
  replaySuccessfulCalls,
  schemaDigest,
  type CompiledSurfaceAppliedProposal,
  type CompiledSurfaceFile,
} from "./compiled-surface.js";
import { entropySurfaceHash } from "./surface.js";
import { ENTROPY_METRIC_VERSION } from "./types.js";
import type {
  EntropyAuditCall,
  EntropyGateResult,
  EntropyProposal,
  EntropyRepairRowInput,
  EntropyReport,
  EntropySurfaceSnapshot,
  EntropyTraceInput,
  EntropyValueObservation,
} from "./types.js";

// The kinds the autonomous loop may apply. Every other proposal carries its
// evidence to the surfaced review queue instead.
export const AUTO_APPLY_PROPOSAL_KINDS: readonly string[] = ["enum-tighten", "noise-quarantine"];

export interface CompileEntropyInput {
  traces: readonly EntropyTraceInput[];
  surface: EntropySurfaceSnapshot;
  repairs?: readonly EntropyRepairRowInput[];
  valueObservations?: readonly EntropyValueObservation[];
  auditCalls?: readonly EntropyAuditCall[];
  artifact?: CompiledSurfaceFile;
  catalogDigest?: string;
}

export type CompileEntropyStatus = "compiled" | "converged" | "rejected";

export interface CompileEntropyOutcome {
  status: CompileEntropyStatus;
  /** The maintained artifact: new when compiled, the input artifact otherwise. */
  artifact?: CompiledSurfaceFile;
  report: EntropyReport;
  after?: EntropyReport;
  proposals: EntropyProposal[];
  gate?: EntropyGateResult;
}

const proposalDetail = (proposal: EntropyProposal): { ref: string; detail: string } => {
  if (proposal.kind === "enum-tighten") {
    return { ref: proposal.ref, detail: `${proposal.key}: ${proposal.values.length} observed values` };
  }
  if (proposal.kind === "noise-quarantine") {
    return { ref: proposal.ref, detail: `${proposal.failed} failed vs ${proposal.succeeded} succeeded` };
  }
  return { ref: "n/a", detail: "review-only" };
};

// Refs the compile touched: tightened schemas and quarantined actions. The
// replay gate scopes to this set; untouched refs keep their schema by
// identity, so projection artifacts elsewhere cannot poison a compile.
const touchedRefs = (before: EntropySurfaceSnapshot, after: EntropySurfaceSnapshot): Set<string> => {
  const beforeByRef = new Map(before.actions.map((action) => [action.ref, action.inputSchema]));
  const touched = new Set<string>();
  for (const action of after.actions) {
    if (stableJsonHash(beforeByRef.get(action.ref)) !== stableJsonHash(action.inputSchema)) {
      touched.add(action.ref);
    }
  }
  for (const ref of beforeByRef.keys()) {
    if (!after.actions.some((action) => action.ref === ref)) touched.add(ref);
  }
  return touched;
};

// Build the maintained artifact from the candidate surface against the live
// surface: overlay entries carry the live base digest, quarantined actions
// carry theirs, and the applied ledger accumulates across compiles.
const artifactFromCandidate = (
  live: EntropySurfaceSnapshot,
  candidate: EntropySurfaceSnapshot,
  proposals: readonly EntropyProposal[],
  gate: { passed: boolean; beforeScore: number; afterScore: number; reasons: string[] },
  evidenceDigest: string,
  previous?: CompiledSurfaceFile,
): CompiledSurfaceFile => {
  const liveByRef = new Map(live.actions.map((action) => [action.ref, action.inputSchema]));
  const actions = candidate.actions
    .filter(
      (action) => stableJsonHash(action.inputSchema) !== stableJsonHash(liveByRef.get(action.ref)),
    )
    .map((action) => ({
      ref: action.ref,
      inputSchema: action.inputSchema as Record<string, unknown>,
      baseSchemaDigest: schemaDigest(liveByRef.get(action.ref)),
    }));
  const candidateRefs = new Set(candidate.actions.map((action) => action.ref));
  const quarantined = live.actions
    .filter((action) => !candidateRefs.has(action.ref))
    .map((action) => ({ ref: action.ref, baseSchemaDigest: schemaDigest(action.inputSchema) }));
  const applied: CompiledSurfaceAppliedProposal[] = [...(previous?.applied ?? [])];
  const seen = new Set(applied.map((entry) => `${entry.kind}:${entry.ref}:${entry.detail}`));
  for (const proposal of proposals) {
    const { ref, detail } = proposalDetail(proposal);
    const identity = `${proposal.kind}:${ref}:${detail}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    applied.push({ kind: proposal.kind, ref, detail });
  }
  return {
    version: COMPILED_SURFACE_VERSION,
    metricVersion: ENTROPY_METRIC_VERSION,
    actions,
    quarantined,
    applied: applied.slice(0, MAX_COMPILED_SURFACE_PROPOSALS),
    gate,
    evidenceDigest,
  };
};

export const compileEntropySurface = (input: CompileEntropyInput): CompileEntropyOutcome => {
  const effective = applyCompiledSurface(input.surface, input.artifact);
  const report = measureEntropy({
    traces: input.traces,
    surface: effective,
    ...(input.repairs ? { repairs: input.repairs } : {}),
    catalogDigest: input.catalogDigest ?? entropySurfaceHash(effective),
  });
  const proposals = proposeEntropyReductions({
    report,
    traces: input.traces,
    surface: effective,
    ...(input.repairs ? { repairs: input.repairs } : {}),
    ...(input.valueObservations ? { valueObservations: input.valueObservations } : {}),
  });
  const auto = proposals.filter((proposal) =>
    (AUTO_APPLY_PROPOSAL_KINDS as readonly string[]).includes(proposal.kind),
  );
  if (auto.length === 0) {
    return {
      status: "converged",
      ...(input.artifact ? { artifact: input.artifact } : {}),
      report,
      proposals,
    };
  }
  const candidate = applyProposalsToSurface(effective, auto);
  const after = measureEntropy({
    traces: input.traces,
    surface: candidate,
    ...(input.repairs ? { repairs: input.repairs } : {}),
    catalogDigest: entropySurfaceHash(candidate),
  });
  const scoreGate = evaluateGate(report, after);
  const violations = replaySuccessfulCalls(
    candidate,
    effective,
    input.traces,
    touchedRefs(effective, candidate),
    input.auditCalls,
  );
  const reasons = [
    ...scoreGate.reasons,
    ...violations.map((violation) => `${violation.ref}: ${violation.reason}`),
  ];
  const gate: EntropyGateResult = {
    passed: scoreGate.passed && violations.length === 0,
    beforeScore: report.score,
    afterScore: after.score,
    delta: scoreGate.delta,
    reasons: scoreGate.passed && violations.length === 0 ? [] : reasons,
  };
  if (gate.passed) {
    const evidenceDigest = stableJsonHash({
      traces: input.traces.length,
      operations: report.totals.operations,
      succeeded: report.totals.succeeded,
      failed: report.totals.failed,
      surface: entropySurfaceHash(effective),
      repairs: input.repairs?.length ?? 0,
      valueObservations: stableJsonHash(input.valueObservations ?? []),
      auditCalls: stableJsonHash(input.auditCalls ?? []),
    });
    return {
      status: "compiled",
      artifact: artifactFromCandidate(
        input.surface,
        candidate,
        auto,
        { passed: true, beforeScore: report.score, afterScore: after.score, reasons: [] },
        evidenceDigest,
        input.artifact,
      ),
      report,
      after,
      proposals,
      gate,
    };
  }
  return {
    status: "rejected",
    ...(input.artifact ? { artifact: input.artifact } : {}),
    report,
    after,
    proposals,
    gate,
  };
};