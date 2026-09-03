// Counterfactual evidence for the compiled surface: replay every recorded
// call against the declared surface and the compiled surface, then classify
// each divergence. The classes count what the artifact would have changed
// about calls models actually made; the falsifiable half of the entropy
// compiler. No model judges anything; TypeBox decides, deterministically.

import { Value } from "typebox/value";
import { applyCompiledSurface, type CompiledSurfaceFile } from "./compiled-surface.js";
import { compareCodeUnits } from "./fingerprint.js";
import { measureEntropy } from "./meter.js";
import { entropySurfaceHash } from "./surface.js";
import type {
  EntropyOperationInput,
  EntropySurfaceSnapshot,
  EntropyTraceInput,
} from "./types.js";

// both-accept and both-reject are the unchanged middle: calls whose fate
// the artifact did not change. The other four classes are the counterfactual
// effect on a recorded call. Succeeded calls the compiled schema would
// reject are costs (the compile overfit its window); calls that failed
// anyway are wins (a cheap typed rejection replaces an expensive failure).
// Calls the declared schema already rejected keep both-reject: no overlay
// or quarantine earns credit for a call that never worked.
export type EntropyTrialClass =
  | "both-accept"
  | "both-reject"
  | "tightening-cost"
  | "typed-failure-win"
  | "quarantine-win"
  | "quarantine-cost";

export interface EntropyTrialTotals {
  operations: number;
  bothAccept: number;
  bothReject: number;
  tighteningCost: number;
  typedFailureWin: number;
  quarantineWin: number;
  quarantineCost: number;
}

export interface EntropyTrialDivergence {
  ref: string;
  trialClass: EntropyTrialClass;
  count: number;
}

export type EntropyTrialVerdict = "no-evidence" | "clean" | "costly";

export interface EntropyTrialReport {
  verdict: EntropyTrialVerdict;
  /** Window score against the declared surface. */
  declaredScore: number;
  /** Window score against the compiled surface. */
  effectiveScore: number;
  delta: number;
  totals: EntropyTrialTotals;
  divergences: EntropyTrialDivergence[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const accepts = (schema: unknown, args: Record<string, unknown>): boolean => {
  try {
    return isRecord(schema) && Value.Check(schema, args);
  } catch {
    return false;
  }
};

const trialClassFields: Record<EntropyTrialClass, keyof EntropyTrialTotals> = {
  "both-accept": "bothAccept",
  "both-reject": "bothReject",
  "tightening-cost": "tighteningCost",
  "typed-failure-win": "typedFailureWin",
  "quarantine-win": "quarantineWin",
  "quarantine-cost": "quarantineCost",
};

const trialClassField = (trialClass: EntropyTrialClass): keyof EntropyTrialTotals =>
  trialClassFields[trialClass];

const classify = (operation: EntropyOperationInput, declaredAccepts: boolean, compiledAccepts: boolean, quarantined: boolean): EntropyTrialClass => {
  if (quarantined) {
    if (!declaredAccepts) return "both-reject";
    return operation.outcome === "succeeded" ? "quarantine-cost" : "quarantine-win";
  }
  if (!declaredAccepts) return "both-reject";
  if (compiledAccepts) return "both-accept";
  return operation.outcome === "succeeded" ? "tightening-cost" : "typed-failure-win";
};

export const runEntropyTrial = (input: {
  traces: readonly EntropyTraceInput[];
  live: EntropySurfaceSnapshot;
  artifact?: CompiledSurfaceFile;
}): EntropyTrialReport => {
  const effective = applyCompiledSurface(input.live, input.artifact);
  const declaredByRef = new Map(
    input.live.actions.map((action) => [action.ref, action.inputSchema]),
  );
  const effectiveByRef = new Map(
    effective.actions.map((action) => [action.ref, action.inputSchema]),
  );
  const declaredReport = measureEntropy({
    traces: input.traces,
    surface: input.live,
    catalogDigest: entropySurfaceHash(input.live),
  });
  const effectiveReport = measureEntropy({
    traces: input.traces,
    surface: effective,
    catalogDigest: entropySurfaceHash(effective),
  });
  const totals: EntropyTrialTotals = {
    operations: 0,
    bothAccept: 0,
    bothReject: 0,
    tighteningCost: 0,
    typedFailureWin: 0,
    quarantineWin: 0,
    quarantineCost: 0,
  };
  const divergenceCounts = new Map<string, number>();
  for (const trace of input.traces) {
    for (const operation of trace.operations) {
      if (operation.ref.startsWith("fabric.")) continue;
      const declared = declaredByRef.get(operation.ref);
      if (declared === undefined) continue;
      const compiled = effectiveByRef.get(operation.ref);
      const quarantined = compiled === undefined;
      const trialClass = classify(
        operation,
        accepts(declared, operation.args),
        quarantined ? false : accepts(compiled, operation.args),
        quarantined,
      );
      totals.operations++;
      totals[trialClassField(trialClass)]++;
      if (trialClass !== "both-accept" && trialClass !== "both-reject") {
        const key = `${operation.ref}\u0000${trialClass}`;
        divergenceCounts.set(key, (divergenceCounts.get(key) ?? 0) + 1);
      }
    }
  }
  const hasEntries =
    (input.artifact?.actions.length ?? 0) + (input.artifact?.quarantined.length ?? 0) > 0;
  const costs = totals.tighteningCost + totals.quarantineCost;
  const verdict: EntropyTrialVerdict =
    !hasEntries || totals.operations === 0 ? "no-evidence" : costs === 0 ? "clean" : "costly";
  const divergences: EntropyTrialDivergence[] = [...divergenceCounts.entries()]
    .map(([key, count]) => {
      const [ref, trialClass] = key.split("\u0000");
      return { ref: ref!, trialClass: trialClass as EntropyTrialClass, count };
    })
    .sort(
      (left, right) =>
        compareCodeUnits(left.ref, right.ref) ||
        compareCodeUnits(left.trialClass, right.trialClass),
    );
  return {
    verdict,
    declaredScore: declaredReport.score,
    effectiveScore: effectiveReport.score,
    delta: effectiveReport.score - declaredReport.score,
    totals,
    divergences,
  };
};
