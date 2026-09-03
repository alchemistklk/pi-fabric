import {
  ENTROPY_INVOCATION_STAGES,
  ENTROPY_METRIC_VERSION,
  ENTROPY_WEIGHTS,
  type EntropyRefReport,
  type EntropyRepairRowInput,
  type EntropyReport,
  type EntropyShapeSignature,
  type EntropySurfaceSnapshot,
  type EntropyTotals,
  type EntropyTraceInput,
} from "./types.js";
import {
  compareCodeUnits,
  roundMetric,
  shannonEntropyBits,
  shapeSignature,
  signatureDistance,
  staticFreedomFromSchema,
} from "./fingerprint.js";

// The meter is a pure function of its inputs: typed trace operations, an
// optional surface snapshot, and the normalized repair table. It reads no
// clocks, no randomness, and no prose — only the residues of non-canonical
// behavior Fabric already records. Same inputs and metric version, same
// report, on every run.

export interface EntropyMeterInput {
  traces: readonly EntropyTraceInput[];
  surface?: EntropySurfaceSnapshot;
  repairs?: readonly EntropyRepairRowInput[];
  catalogDigest?: string;
}

const DISCOVERY_PREFIX = "fabric.discovery.";
const WORKFLOW_PREFIX = "fabric.workflow.";
const DEFAULT_TASK_KEY = "(none)";
const TOP_SIGNATURES = 8;

interface RefAccumulator {
  calls: number;
  succeeded: number;
  failed: number;
  signatures: Map<string, number>;
  stages: Map<string, number>;
  churnPairs: number;
  churnSum: number;
}

export const measureEntropy = (input: EntropyMeterInput): EntropyReport => {
  const surfaceByRef = new Map<string, unknown>();
  if (input.surface) {
    for (const action of input.surface.actions) surfaceByRef.set(action.ref, action.inputSchema);
  }

  const lexiconByRef = new Map<string, number>();
  let lexiconRows = 0;
  for (const row of input.repairs ?? []) {
    lexiconByRef.set(row.ref, (lexiconByRef.get(row.ref) ?? 0) + 1);
    lexiconRows += 1;
  }

  const totals: EntropyTotals = {
    traces: input.traces.length,
    operations: 0,
    actionOperations: 0,
    discoveryOperations: 0,
    workflowOperations: 0,
    succeeded: 0,
    failed: 0,
    aborted: 0,
    timedOut: 0,
    invocationRejections: 0,
    invocationRejectionsPer1k: 0,
  };

  const refs = new Map<string, RefAccumulator>();
  const taskSequences = new Map<string, Map<string, number>>();
  let churnPairs = 0;
  let churnSum = 0;

  const accumulator = (ref: string): RefAccumulator => {
    const existing = refs.get(ref);
    if (existing) return existing;
    const created: RefAccumulator = {
      calls: 0,
      succeeded: 0,
      failed: 0,
      signatures: new Map<string, number>(),
      stages: new Map<string, number>(),
      churnPairs: 0,
      churnSum: 0,
    };
    refs.set(ref, created);
    return created;
  };

  for (const sourceTrace of input.traces) {
    const taskKey = sourceTrace.taskKey ?? DEFAULT_TASK_KEY;
    const sequence: string[] = [];
    const pendingFailed = new Map<string, string>();
    for (const operation of sourceTrace.operations) {
      totals.operations += 1;
      if (operation.ref.startsWith(DISCOVERY_PREFIX)) {
        totals.discoveryOperations += 1;
        continue;
      }
      if (operation.ref.startsWith(WORKFLOW_PREFIX)) {
        totals.workflowOperations += 1;
        continue;
      }
      totals.actionOperations += 1;
      sequence.push(operation.ref);
      const acc = accumulator(operation.ref);
      acc.calls += 1;
      if (operation.outcome === "succeeded") {
        totals.succeeded += 1;
        acc.succeeded += 1;
      } else if (operation.outcome === "failed") {
        totals.failed += 1;
        acc.failed += 1;
      } else if (operation.outcome === "aborted") {
        totals.aborted += 1;
      } else {
        totals.timedOut += 1;
      }
      const signature = shapeSignature(operation.args);
      acc.signatures.set(signature, (acc.signatures.get(signature) ?? 0) + 1);
      if (operation.outcome === "failed") {
        const stage = operation.failureStage ?? "unknown";
        acc.stages.set(stage, (acc.stages.get(stage) ?? 0) + 1);
        if (ENTROPY_INVOCATION_STAGES.includes(stage)) totals.invocationRejections += 1;
      }
      const pending = pendingFailed.get(operation.ref);
      if (pending !== undefined) {
        const distance = signatureDistance(pending, signature);
        acc.churnPairs += 1;
        acc.churnSum += distance;
        churnPairs += 1;
        churnSum += distance;
        pendingFailed.delete(operation.ref);
      }
      if (operation.outcome === "failed") pendingFailed.set(operation.ref, signature);
    }
    if (sequence.length > 0) {
      const key = sequence.join("→");
      const perTask = taskSequences.get(taskKey) ?? new Map<string, number>();
      perTask.set(key, (perTask.get(key) ?? 0) + 1);
      taskSequences.set(taskKey, perTask);
    }
  }

  // Sorted iteration keeps every downstream sum independent of input order.
  const refEntries = [...refs.entries()].sort(([left], [right]) => compareCodeUnits(left, right));
  const refReports: EntropyRefReport[] = [];
  let staticFreedomTotal = 0;
  let shapeWeighted = 0;
  let failureStageWeighted = 0;
  let scoreSum = 0;
  for (const [ref, acc] of refEntries) {
    const shapeEntropyBits = shannonEntropyBits([...acc.signatures.values()]);
    const failureStageEntropyBits = shannonEntropyBits([...acc.stages.values()]);
    const refChurnRate = acc.churnPairs > 0 ? roundMetric(acc.churnSum / acc.churnPairs) : 0;
    const lexicon = lexiconByRef.get(ref) ?? 0;
    const staticFreedom = surfaceByRef.has(ref)
      ? staticFreedomFromSchema(surfaceByRef.get(ref))
      : 0;
    staticFreedomTotal += staticFreedom;
    shapeWeighted += shapeEntropyBits * acc.calls;
    failureStageWeighted += failureStageEntropyBits * acc.failed;
    const score = roundMetric(
      ENTROPY_WEIGHTS.shape * shapeEntropyBits +
        ENTROPY_WEIGHTS.failureStage * failureStageEntropyBits +
        ENTROPY_WEIGHTS.churn * refChurnRate +
        ENTROPY_WEIGHTS.lexicon * lexicon +
        ENTROPY_WEIGHTS.staticFreedom * staticFreedom,
    );
    scoreSum += score;
    const shapeSignatures: EntropyShapeSignature[] = [...acc.signatures.entries()]
      .map(([signature, count]) => ({ signature, count }))
      .sort(
        (left, right) => right.count - left.count || compareCodeUnits(left.signature, right.signature),
      )
      .slice(0, TOP_SIGNATURES);
    refReports.push({
      ref,
      calls: acc.calls,
      succeeded: acc.succeeded,
      failed: acc.failed,
      shapeSignatures,
      shapeEntropyBits,
      failureStageEntropyBits,
      churnRate: refChurnRate,
      lexiconRows: lexicon,
      staticFreedom,
      score,
    });
  }

  const navigationRatio =
    totals.actionOperations > 0
      ? roundMetric(totals.discoveryOperations / totals.actionOperations)
      : 0;
  let flowWeighted = 0;
  let flowOccurrences = 0;
  for (const perTask of taskSequences.values()) {
    const counts = [...perTask.values()];
    const occurrences = counts.reduce((sum, value) => sum + value, 0);
    flowWeighted += shannonEntropyBits(counts) * occurrences;
    flowOccurrences += occurrences;
  }
  const flowEntropyBits = flowOccurrences > 0 ? roundMetric(flowWeighted / flowOccurrences) : 0;
  totals.invocationRejectionsPer1k =
    totals.actionOperations > 0
      ? roundMetric((totals.invocationRejections / totals.actionOperations) * 1000)
      : 0;

  const score = roundMetric(
    (scoreSum +
      ENTROPY_WEIGHTS.navigation * navigationRatio +
      ENTROPY_WEIGHTS.flow * flowEntropyBits) /
      Math.max(1, totals.succeeded),
  );

  const sortedRefs = [...refReports].sort(
    (left, right) => right.score - left.score || compareCodeUnits(left.ref, right.ref),
  );

  return {
    metricVersion: ENTROPY_METRIC_VERSION,
    catalogDigest: input.catalogDigest ?? "",
    totals,
    shapeEntropyBits:
      totals.actionOperations > 0 ? roundMetric(shapeWeighted / totals.actionOperations) : 0,
    failureStageEntropyBits: totals.failed > 0 ? roundMetric(failureStageWeighted / totals.failed) : 0,
    churnRate: churnPairs > 0 ? roundMetric(churnSum / churnPairs) : 0,
    navigationRatio,
    flowEntropyBits,
    lexiconRows,
    staticFreedom: roundMetric(staticFreedomTotal),
    score,
    refs: sortedRefs,
  };
};
