import type {
  EntropyGateResult,
  EntropyProposal,
  EntropyRefReport,
  EntropyReport,
  EntropyRepairRowInput,
  EntropySurfaceAction,
  EntropySurfaceSnapshot,
  EntropyTraceInput,
  EntropyValueObservation,
} from "./types.js";
import { compareCodeUnits, roundMetric } from "./fingerprint.js";

// Deterministic reduction proposals. Each pass is a pure function over the
// same typed artifacts the meter reads, with fixed thresholds, and every
// proposal carries the evidence that triggered it. `applyProposalsToSurface`
// rewrites the surface for the mechanically applicable kinds; overload-split
// and sequence-fuse author new composite definitions, and declare-enum only
// ever suggests a domain the schema has not claimed, so all three stay
// review-only. The gate is the ratchet: a compiled surface must never
// increase the measured score and must never drop successful calls.

export interface EntropyProposalInput {
  report: EntropyReport;
  traces: readonly EntropyTraceInput[];
  surface?: EntropySurfaceSnapshot;
  repairs?: readonly EntropyRepairRowInput[];
  valueObservations?: readonly EntropyValueObservation[];
}

const ENUM_MIN_OBSERVATIONS = 8;
const ENUM_MAX_DISTINCT = 8;
const ENUM_MIN_TOP_SHARE = 0.5;
const SPLIT_MIN_SHAPE_ENTROPY_BITS = 1;
const SPLIT_MIN_CLUSTER_CALLS = 2;
const FUSE_MIN_SEQUENCE_LENGTH = 3;
const FUSE_MAX_SEQUENCE_LENGTH = 6;
const FUSE_MIN_OCCURRENCES = 2;
const QUARANTINE_MIN_CALLS = 3;
const QUARANTINE_MIN_STAGE_ENTROPY_BITS = 1;
const MAX_PROPOSALS_PER_KIND = 8;

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const valueKey = (value: string | number | boolean): string => `${typeof value}:${String(value)}`;

const schemaProperties = (schema: unknown): Record<string, unknown> | undefined => {
  if (!isPlainRecord(schema)) return undefined;
  const properties = schema.properties;
  return isPlainRecord(properties) ? properties : undefined;
};

const enumKeys = (schema: unknown): Set<string> | undefined => {
  if (!isPlainRecord(schema) || !Array.isArray(schema.enum)) return undefined;
  const keys = new Set<string>();
  for (const entry of schema.enum) {
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
      keys.add(valueKey(entry));
    }
  }
  return keys;
};

const contains = (outer: readonly string[], inner: readonly string[]): boolean => {
  if (outer.length < inner.length) return false;
  for (let start = 0; start + inner.length <= outer.length; start++) {
    let matches = true;
    for (let index = 0; index < inner.length; index++) {
      if (outer[start + index] !== inner[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
};

interface EnumCandidate {
  entry: {
    ref: string;
    key: string;
    counts: Map<string, { value: string | number | boolean; count: number }>;
    total: number;
  };
  ranked: { value: string | number | boolean; count: number }[];
  topShare: number;
}

// An enum the effective schema already declares is a floor. Observed
// values outside it are pre-birth evidence: calls recorded before the
// overlay existed (the live session carries them for its whole life) or
// after a digest proof fell. The fresh derivation drops them instead of
// re-proposing a wider enum the ratchet must then reject every turn.
// Tightening beneath the floor still proposes; a derivation identical to
// the declared enum converges. Widening resets only when the base schema
// drifts (the digest proof drops the overlay and the enum re-derives from
// the live surface) or through review.
const tightenBeneathDeclaredEnum = (
  candidate: EnumCandidate,
  declaredDomain: ReadonlySet<string>,
): EnumCandidate | undefined => {
  const ranked = candidate.ranked.filter((item) => declaredDomain.has(valueKey(item.value)));
  if (ranked.length === 0 || ranked.length === declaredDomain.size) return undefined;
  return { ...candidate, ranked };
};

export const proposeEntropyReductions = (input: EntropyProposalInput): EntropyProposal[] => {
  const calledRefs = new Map<string, EntropyRefReport>();
  for (const ref of input.report.refs) calledRefs.set(ref.ref, ref);
  const surfaceByRef = new Map<string, unknown>();
  const surfaceRefs = new Set<string>();
  if (input.surface) {
    for (const action of input.surface.actions) {
      surfaceByRef.set(action.ref, action.inputSchema);
      surfaceRefs.add(action.ref);
    }
  }

  const proposals: EntropyProposal[] = [];

  // enum-tighten: a closed-domain parameter whose observed values are few
  // and concentrated tightens beneath its declared enum, so future
  // off-modal values fail (or repair) deterministically instead of
  // slipping through an unused declared value. Open-domain parameters with
  // the same shape become declare-enum review signals below.
  const observations = new Map<
    string,
    {
      ref: string;
      key: string;
      counts: Map<string, { value: string | number | boolean; count: number }>;
      total: number;
    }
  >();
  const observeValue = (
    ref: string,
    key: string,
    value: string | number | boolean,
    weight = 1,
  ): void => {
    const id = `${ref}\u0000${key}`;
    const entry =
      observations.get(id) ??
      {
        ref,
        key,
        counts: new Map<string, { value: string | number | boolean; count: number }>(),
        total: 0,
      };
    const valueId = valueKey(value);
    const existing = entry.counts.get(valueId);
    entry.counts.set(valueId, { value, count: (existing?.count ?? 0) + weight });
    entry.total += weight;
    observations.set(id, entry);
  };
  // Verbatim audit observations are the authoritative value corpus when
  // supplied: audits carry every argument, including the parameters the
  // trace projection drops. Without them the scan uses the projected trace
  // args.
  if (input.valueObservations) {
    for (const observation of input.valueObservations) {
      observeValue(observation.ref, observation.key, observation.value, observation.count ?? 1);
    }
  } else {
    for (const sourceTrace of input.traces) {
      for (const operation of sourceTrace.operations) {
        if (operation.ref.startsWith("fabric.")) continue;
        for (const [key, value] of Object.entries(operation.args)) {
          if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
            continue;
          }
          observeValue(operation.ref, key, value);
        }
      }
    }
  }
  const eligibleCandidates = [...observations.values()]
    .filter((entry) => entry.total >= ENUM_MIN_OBSERVATIONS)
    .filter((entry) => entry.counts.size >= 2 && entry.counts.size <= ENUM_MAX_DISTINCT)
    .map((entry): EnumCandidate => {
      const ranked = [...entry.counts.values()].sort(
        (left, right) =>
          right.count - left.count || compareCodeUnits(valueKey(left.value), valueKey(right.value)),
      );
      return { entry, ranked, topShare: roundMetric(ranked[0]!.count / entry.total) };
    })
    .filter((candidate) => candidate.topShare >= ENUM_MIN_TOP_SHARE);
  // Closed-domain rule: auto enum-tighten may only remove freedom the
  // effective schema already declares finite. A parameter whose schema
  // carries an enum is a closed domain, so tightening beneath it is
  // measured subtraction of declared freedom. A free parameter, an
  // undeclared key, or a missing surface proves nothing about the domain:
  // the same observations become a declare-enum review signal for the
  // surface author instead, because inventing a domain the schema never
  // claimed is how a compiler sharpens the wrong entropy. A declared
  // boolean is already closed and priced below any enum, so it never
  // proposes.
  const closedCandidates: EnumCandidate[] = [];
  const openCandidates: EnumCandidate[] = [];
  for (const candidate of eligibleCandidates) {
    const properties = input.surface
      ? schemaProperties(surfaceByRef.get(candidate.entry.ref))
      : undefined;
    const target = properties ? properties[candidate.entry.key] : undefined;
    if (isPlainRecord(target) && target.type === "boolean") continue;
    const declaredDomain = target ? enumKeys(target) : undefined;
    if (declaredDomain) {
      const tightened = tightenBeneathDeclaredEnum(candidate, declaredDomain);
      if (tightened) closedCandidates.push(tightened);
    } else {
      openCandidates.push(candidate);
    }
  }
  const byRefKey = (left: EnumCandidate, right: EnumCandidate): number =>
    compareCodeUnits(
      `${left.entry.ref}\u0000${left.entry.key}`,
      `${right.entry.ref}\u0000${right.entry.key}`,
    );
  for (const candidate of closedCandidates.sort(byRefKey).slice(0, MAX_PROPOSALS_PER_KIND)) {
    proposals.push({
      kind: "enum-tighten",
      ref: candidate.entry.ref,
      key: candidate.entry.key,
      values: candidate.ranked.map((item) => item.value),
      calls: candidate.entry.total,
      distinct: candidate.ranked.length,
      topShare: candidate.topShare,
    });
  }
  for (const candidate of openCandidates.sort(byRefKey).slice(0, MAX_PROPOSALS_PER_KIND)) {
    proposals.push({
      kind: "declare-enum",
      ref: candidate.entry.ref,
      key: candidate.entry.key,
      values: candidate.ranked.map((item) => item.value),
      calls: candidate.entry.total,
      distinct: candidate.entry.counts.size,
      topShare: candidate.topShare,
    });
  }

  // modal-rename: a repair row whose target is called means the spilled
  // spelling is the model's modal grammar. Compile it into the schema and
  // retire the row instead of paying the map forever.
  const repairRows = [...(input.repairs ?? [])].sort(
    (left, right) =>
      compareCodeUnits(left.ref, right.ref) ||
      compareCodeUnits(left.from, right.from) ||
      compareCodeUnits(left.to, right.to),
  );
  for (const row of repairRows) {
    if (!calledRefs.has(row.ref)) continue;
    if (input.surface) {
      if (row.kind === "keyAlias") {
        const properties = schemaProperties(surfaceByRef.get(row.ref));
        if (properties && row.from in properties) continue;
      } else {
        const provider = row.ref.split(".")[0] ?? row.ref;
        if (surfaceRefs.has(`${provider}.${row.from}`)) continue;
      }
    }
    proposals.push({
      kind: "modal-rename",
      level: row.kind === "keyAlias" ? "key" : "action",
      ref: row.ref,
      from: row.from,
      to: row.to,
      note:
        row.kind === "keyAlias"
          ? "the spilled spelling dominates observed calls; rename the declared key and retire the repair row"
          : "the spilled action name dominates observed calls; rename the declared action and retire the repair row",
    });
  }

  // overload-split: one ref carrying two disjoint parameter key-sets is an
  // overloaded action; splitting removes the per-call either/or freedom.
  const overloadRefs = new Set(
    input.report.refs
      .filter((ref) => ref.shapeEntropyBits >= SPLIT_MIN_SHAPE_ENTROPY_BITS)
      .map((ref) => ref.ref),
  );
  if (overloadRefs.size > 0) {
    const keySets = new Map<string, Map<string, { keys: string[]; calls: number }>>();
    for (const sourceTrace of input.traces) {
      for (const operation of sourceTrace.operations) {
        if (!overloadRefs.has(operation.ref)) continue;
        const keys = Object.keys(operation.args).sort();
        const id = keys.join("\u0000");
        const perRef = keySets.get(operation.ref) ?? new Map<string, { keys: string[]; calls: number }>();
        const cluster = perRef.get(id) ?? { keys, calls: 0 };
        cluster.calls += 1;
        perRef.set(id, cluster);
        keySets.set(operation.ref, perRef);
      }
    }
    let overloadCount = 0;
    for (const [ref, perRef] of [...keySets.entries()].sort(([left], [right]) =>
      compareCodeUnits(left, right),
    )) {
      if (overloadCount >= MAX_PROPOSALS_PER_KIND) break;
      const clusters = [...perRef.values()]
        .filter((cluster) => cluster.calls >= SPLIT_MIN_CLUSTER_CALLS)
        .sort(
          (left, right) =>
            right.calls - left.calls || compareCodeUnits(left.keys.join(","), right.keys.join(",")),
        );
      const disjoint: { keys: string[]; calls: number }[] = [];
      for (const cluster of clusters) {
        const keys = new Set(cluster.keys);
        if (disjoint.every((candidate) => candidate.keys.every((key) => !keys.has(key)))) {
          disjoint.push(cluster);
        }
      }
      if (disjoint.length >= 2) {
        overloadCount += 1;
        const report = calledRefs.get(ref);
        proposals.push({
          kind: "overload-split",
          ref,
          shapeEntropyBits: report?.shapeEntropyBits ?? 0,
          clusters: disjoint.slice(0, MAX_PROPOSALS_PER_KIND).map((cluster) => ({
            keys: cluster.keys,
            calls: cluster.calls,
          })),
        });
      }
    }
  }

  // sequence-fuse: a contiguous multi-ref action sequence that repeats across
  // executions is a composite action (or skill) waiting to be extracted.
  const sequenceCounts = new Map<string, { sequence: string[]; occurrences: number }>();
  for (const sourceTrace of input.traces) {
    const refs = sourceTrace.operations
      .filter((operation) => !operation.ref.startsWith("fabric."))
      .map((operation) => operation.ref);
    for (
      let length = FUSE_MIN_SEQUENCE_LENGTH;
      length <= Math.min(FUSE_MAX_SEQUENCE_LENGTH, refs.length);
      length++
    ) {
      for (let start = 0; start + length <= refs.length; start++) {
        const sequence = refs.slice(start, start + length);
        if (new Set(sequence).size < 2) continue;
        const id = sequence.join("→");
        const entry = sequenceCounts.get(id) ?? { sequence, occurrences: 0 };
        entry.occurrences += 1;
        sequenceCounts.set(id, entry);
      }
    }
  }
  const fuseCandidates = [...sequenceCounts.values()]
    .filter((entry) => entry.occurrences >= FUSE_MIN_OCCURRENCES)
    .sort(
      (left, right) =>
        right.sequence.length - left.sequence.length ||
        right.occurrences - left.occurrences ||
        compareCodeUnits(left.sequence.join("→"), right.sequence.join("→")),
    );
  const selected: { sequence: string[]; occurrences: number }[] = [];
  for (const candidate of fuseCandidates) {
    if (selected.length >= MAX_PROPOSALS_PER_KIND) break;
    const redundant = selected.some(
      (chosen) =>
        contains(candidate.sequence, chosen.sequence) || contains(chosen.sequence, candidate.sequence),
    );
    if (redundant) continue;
    selected.push(candidate);
  }
  for (const candidate of selected) {
    proposals.push({
      kind: "sequence-fuse",
      sequence: candidate.sequence,
      occurrences: candidate.occurrences,
    });
  }

  // noise-quarantine: a called ref that fails more than it succeeds, with
  // more than one failure stage, is a candidate to hide from the
  // model-facing catalog. The precondition (more failures than successes)
  // carries the replay-safety argument for retiring it.
  const quarantineCandidates = input.report.refs
    .filter(
      (ref) =>
        ref.calls >= QUARANTINE_MIN_CALLS &&
        ref.failed > ref.succeeded &&
        ref.failureStageEntropyBits >= QUARANTINE_MIN_STAGE_ENTROPY_BITS,
    )
    .filter((ref) => !input.surface || surfaceRefs.has(ref.ref))
    .slice(0, MAX_PROPOSALS_PER_KIND);
  for (const ref of quarantineCandidates) {
    proposals.push({
      kind: "noise-quarantine",
      ref: ref.ref,
      calls: ref.calls,
      succeeded: ref.succeeded,
      failed: ref.failed,
      failureStageEntropyBits: ref.failureStageEntropyBits,
    });
  }

  return proposals;
};

const deepCloneJson = (value: unknown): unknown =>
  value === undefined ? {} : (JSON.parse(JSON.stringify(value)) as unknown);

// Apply the mechanically applicable proposals as a pure surface rewrite.
// The input surface is never mutated; enum-tighten injects the observed
// enum beneath the declared one, noise-quarantine removes the action,
// modal-rename renames the declared key or action to the model's modal
// spelling. Overload-split, sequence-fuse, and declare-enum produce
// review-only proposals and are skipped here.
export const applyProposalsToSurface = (
  surface: EntropySurfaceSnapshot,
  proposals: readonly EntropyProposal[],
): EntropySurfaceSnapshot => {
  const actions: EntropySurfaceAction[] = surface.actions.map((action) => ({
    ref: action.ref,
    inputSchema: deepCloneJson(action.inputSchema),
  }));
  const quarantined = new Set<string>();
  for (const proposal of proposals) {
    if (proposal.kind === "noise-quarantine") {
      quarantined.add(proposal.ref);
      continue;
    }
    if (proposal.kind === "modal-rename" && proposal.level === "action") {
      const provider = proposal.ref.split(".")[0] ?? proposal.ref;
      const renamed = `${provider}.${proposal.from}`;
      for (const action of actions) {
        if (action.ref === proposal.ref) action.ref = renamed;
      }
      continue;
    }
    if (proposal.kind === "enum-tighten" || (proposal.kind === "modal-rename" && proposal.level === "key")) {
      const action = actions.find((candidate) => candidate.ref === proposal.ref);
      if (!action || !isPlainRecord(action.inputSchema)) continue;
      const schema = action.inputSchema;
      const properties = schemaProperties(schema);
      if (!properties) continue;
      if (proposal.kind === "enum-tighten") {
        if (!isPlainRecord(properties[proposal.key])) continue;
        properties[proposal.key] = {
          ...(properties[proposal.key] as Record<string, unknown>),
          enum: [...proposal.values],
        };
        continue;
      }
      if (!(proposal.to in properties) || proposal.from in properties) continue;
      properties[proposal.from] = properties[proposal.to]!;
      delete properties[proposal.to];
      if (Array.isArray(schema.required)) {
        schema.required = schema.required.map((key) => (key === proposal.to ? proposal.from : key));
      }
    }
  }
  const survivors = actions
    .filter((action) => !quarantined.has(action.ref))
    .sort((left, right) => compareCodeUnits(left.ref, right.ref));
  return { version: 1, actions: survivors };
};

// The ratchet: a compiled surface must not increase the measured score and
// must preserve every successful call. Monotonicity is measured, never
// argued.
export const evaluateGate = (before: EntropyReport, after: EntropyReport): EntropyGateResult => {
  const reasons: string[] = [];
  if (after.score > before.score) {
    reasons.push(`score increased ${before.score} → ${after.score}`);
  }
  if (after.totals.succeeded < before.totals.succeeded) {
    reasons.push(
      `successful calls dropped ${before.totals.succeeded} → ${after.totals.succeeded}`,
    );
  }
  return {
    passed: reasons.length === 0,
    beforeScore: before.score,
    afterScore: after.score,
    delta: roundMetric(after.score - before.score),
    reasons,
  };
};
