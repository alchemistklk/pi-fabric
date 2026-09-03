// Machine-wide value-observation pooling for the entropy compiler. The
// session window stays small by design (gate-local, always fresh), but
// sparse closed domains never reach the derivation thresholds inside one
// window. The pool accumulates per-(ref, key, value) counts across every
// window the compiler reads, with exact per-session deltas so a growing
// session file is never counted twice and a rewritten one retracts its old
// contribution before adding the new one. Bounded by construction: each
// entry tracks at most POOL_TRACKED_VALUES distinct values (above the
// derivation's ENUM_MAX_DISTINCT, so an overflowed domain stays provably
// ineligible instead of silently re-qualifying after eviction),
// POOL_TRACKED_SESSIONS files carry per-session counts for exact deltas,
// and evicted sessions bake into the totals with their digest remembered
// so the same evidence never merges twice.

import { stableJsonHash } from "../core/stable-hash.js";
import { compareCodeUnits } from "./fingerprint.js";
import type { EntropyValueObservation } from "./types.js";

export const OBSERVATION_POOL_VERSION = 1 as const;
export const POOL_TRACKED_VALUES = 16;
export const POOL_TRACKED_SESSIONS = 16;
export const POOL_BAKED_DIGESTS = 512;

export interface EntropyPoolValueCount {
  value: string | number | boolean;
  count: number;
}

export interface EntropyObservationPoolEntry {
  ref: string;
  key: string;
  values: EntropyPoolValueCount[];
  total: number;
}

export interface EntropyPoolTrackedSession {
  file: string;
  digest: string;
  counts: Record<string, number>;
}

export interface EntropyObservationPoolFile {
  version: typeof OBSERVATION_POOL_VERSION;
  entries: EntropyObservationPoolEntry[];
  tracked: EntropyPoolTrackedSession[];
  baked: string[];
}

export interface EntropyObservationWindow {
  file: string;
  observations: readonly EntropyValueObservation[];
}

export interface MergedObservationPool {
  file: EntropyObservationPoolFile;
  mergedSessions: number;
  skippedSessions: number;
}

const SEPARATOR = "\u0000";

// Identity of one observation: ref, key, and the typed value, so `1`
// (number) and "1" (string) stay distinct evidence.
export const observationIdentity = (
  observation: EntropyValueObservation,
): string =>
  `${observation.ref}${SEPARATOR}${observation.key}${SEPARATOR}${typeof observation.value}:${String(observation.value)}`;

const entryValueKey = (value: string | number | boolean): string =>
  `${typeof value}:${String(value)}`;

const valueFromKey = (valueKey: string): string | number | boolean => {
  const separator = valueKey.indexOf(":");
  const type = valueKey.slice(0, separator);
  const raw = valueKey.slice(separator + 1);
  if (type === "number") return Number(raw);
  if (type === "boolean") return raw === "true";
  return raw;
};

const parseIdentity = (identity: string): { ref: string; key: string; valueKey: string } => {
  const first = identity.indexOf(SEPARATOR);
  const second = identity.indexOf(SEPARATOR, first + 1);
  return {
    ref: identity.slice(0, first),
    key: identity.slice(first + 1, second),
    valueKey: identity.slice(second + 1),
  };
};

// Digest of one window's observation multiset: identical multisets hash
// identically however the session file grew or was rewritten, so the same
// evidence never merges twice.
export const observationWindowDigest = (
  observations: readonly EntropyValueObservation[],
): string => {
  const identities = observations.map((observation) => observationIdentity(observation));
  identities.sort(compareCodeUnits);
  return stableJsonHash(identities);
};

const countsOf = (
  observations: readonly EntropyValueObservation[],
): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const observation of observations) {
    const identity = observationIdentity(observation);
    counts[identity] = (counts[identity] ?? 0) + (observation.count ?? 1);
  }
  return counts;
};

interface WorkingEntry {
  ref: string;
  key: string;
  values: Map<string, { value: string | number | boolean; count: number }>;
  total: number;
}

const workingFromPool = (
  pool: EntropyObservationPoolFile | undefined,
): Map<string, WorkingEntry> => {
  const working = new Map<string, WorkingEntry>();
  if (!pool) return working;
  for (const entry of pool.entries) {
    const values = new Map<string, { value: string | number | boolean; count: number }>();
    for (const item of entry.values) {
      values.set(entryValueKey(item.value), { value: item.value, count: item.count });
    }
    working.set(`${entry.ref}${SEPARATOR}${entry.key}`, {
      ref: entry.ref,
      key: entry.key,
      values,
      total: entry.total,
    });
  }
  return working;
};

const applyEntryDelta = (
  working: Map<string, WorkingEntry>,
  identity: string,
  weight: number,
): string => {
  const { ref, key, valueKey } = parseIdentity(identity);
  const entryId = `${ref}${SEPARATOR}${key}`;
  let entry = working.get(entryId);
  if (!entry) {
    entry = { ref, key, values: new Map(), total: 0 };
    working.set(entryId, entry);
  }
  const current = entry.values.get(valueKey);
  const nextCount = (current?.count ?? 0) + weight;
  entry.total += weight;
  if (nextCount > 0) {
    entry.values.set(valueKey, {
      value: current?.value ?? valueFromKey(valueKey),
      count: nextCount,
    });
  } else {
    entry.values.delete(valueKey);
  }
  if (entry.values.size === 0 && entry.total <= 0) working.delete(entryId);
  return entryId;
};

// The tracked-value cap bounds the pool file. Eviction only ever touches
// entries already past the derivation's distinct guard (16 tracked values
// exceed the 8-value eligibility), so it can never flip an eligible
// parameter ineligible, and an overflowed domain stays provably open.
const enforceValueCap = (entry: WorkingEntry): void => {
  while (entry.values.size > POOL_TRACKED_VALUES) {
    let evictKey: string | undefined;
    let evictCount = Number.POSITIVE_INFINITY;
    for (const [valueKey, item] of entry.values) {
      if (
        evictKey === undefined ||
        item.count < evictCount ||
        (item.count === evictCount && compareCodeUnits(valueKey, evictKey) > 0)
      ) {
        evictKey = valueKey;
        evictCount = item.count;
      }
    }
    if (evictKey === undefined) return;
    entry.total -= entry.values.get(evictKey)!.count;
    entry.values.delete(evictKey);
  }
};

const serializePool = (
  working: Map<string, WorkingEntry>,
  tracked: EntropyPoolTrackedSession[],
  baked: string[],
): EntropyObservationPoolFile => ({
  version: OBSERVATION_POOL_VERSION,
  entries: [...working.values()]
    .map((entry) => ({
      ref: entry.ref,
      key: entry.key,
      total: entry.total,
      values: [...entry.values.values()]
        .map((item) => ({ value: item.value, count: item.count }))
        .sort(
          (left, right) =>
            right.count - left.count ||
            compareCodeUnits(entryValueKey(left.value), entryValueKey(right.value)),
        ),
    }))
    .sort((left, right) =>
      compareCodeUnits(
        `${left.ref}${SEPARATOR}${left.key}`,
        `${right.ref}${SEPARATOR}${right.key}`,
      ),
    ),
  tracked,
  baked,
});

// Merge one session-window scan into the pool. A session contributes
// exactly once per content: unchanged files skip by digest, grown or
// rewritten files contribute the exact delta from their previous counts,
// and sessions evicted from tracking bake with their digest remembered, so
// no evidence can inflate by re-reading.
export const mergeObservationWindow = (
  pool: EntropyObservationPoolFile | undefined,
  windows: readonly EntropyObservationWindow[],
): MergedObservationPool => {
  const working = workingFromPool(pool);
  const tracked = [...(pool?.tracked ?? [])];
  const baked = [...(pool?.baked ?? [])];
  const bakedSet = new Set(baked);
  const trackedDigests = new Set(tracked.map((session) => session.digest));
  let mergedSessions = 0;
  let skippedSessions = 0;
  for (const window of windows) {
    const digest = observationWindowDigest(window.observations);
    if (bakedSet.has(digest) || trackedDigests.has(digest)) {
      skippedSessions += 1;
      continue;
    }
    const existingIndex = tracked.findIndex((session) => session.file === window.file);
    const existing = existingIndex >= 0 ? tracked[existingIndex] : undefined;
    const fresh = countsOf(window.observations);
    const delta: Record<string, number> = { ...fresh };
    if (existing) {
      for (const [identity, count] of Object.entries(existing.counts)) {
        delta[identity] = (delta[identity] ?? 0) - count;
      }
    }
    const touched = new Set<string>();
    for (const [identity, weight] of Object.entries(delta)) {
      if (weight === 0) continue;
      touched.add(applyEntryDelta(working, identity, weight));
    }
    for (const entryId of touched) {
      const entry = working.get(entryId);
      if (entry) enforceValueCap(entry);
    }
    const trackedSession = { file: window.file, digest, counts: fresh };
    if (existing) {
      tracked[existingIndex] = trackedSession;
    } else {
      tracked.push(trackedSession);
      if (tracked.length > POOL_TRACKED_SESSIONS) {
        const oldest = tracked.shift()!;
        if (!bakedSet.has(oldest.digest)) {
          baked.push(oldest.digest);
          bakedSet.add(oldest.digest);
          while (baked.length > POOL_BAKED_DIGESTS) {
            bakedSet.delete(baked.shift()!);
          }
        }
      }
    }
    trackedDigests.add(digest);
    mergedSessions += 1;
  }
  return {
    file: serializePool(working, tracked, baked),
    mergedSessions,
    skippedSessions,
  };
};

// Expand the pool into the flat value-observation corpus the derivation
// consumes. Counts travel as multiplicity, so pooled evidence costs one
// observation per distinct value instead of one per recorded call.
export const poolToValueObservations = (
  pool: EntropyObservationPoolFile | undefined,
): EntropyValueObservation[] => {
  if (!pool) return [];
  const observations: EntropyValueObservation[] = [];
  for (const entry of pool.entries) {
    for (const item of entry.values) {
      observations.push({ ref: entry.ref, key: entry.key, value: item.value, count: item.count });
    }
  }
  return observations;
};
