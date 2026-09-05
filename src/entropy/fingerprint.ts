// Deterministic fingerprints for the entropy meter: canonical call-shape
// signatures, signature distance (retry churn), Shannon entropy in bits, and
// the static freedom score of a JSON Schema. Everything here is a pure
// function of its inputs; the same value always yields the same fingerprint.

import type { EntropyTrend } from "./types.js";

const SIGNATURE_MAX_KEYS = 32;
const SIGNATURE_MAX_DEPTH = 3;
// Enum cardinality whose freedom saturates at 1.0 (log2 of 64 values).
const ENUM_SATURATION_BITS = 6;

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Fixed rounding for every reported metric value. Same inputs, same floats,
// same six decimal places — report JSON is byte-stable. Negative zero
// collapses to zero so single-class entropies compare equal to zero.
export const roundMetric = (value: number): number => {
  const rounded = Math.round(value * 1e6) / 1e6;
  return rounded === 0 ? 0 : rounded;
};

// Code-unit string comparison: locale-independent, so ordering never varies
// with the host's ICU data.
export const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const typeTag = (value: unknown, depth: number): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "arr";
  switch (typeof value) {
    case "string":
      return "str";
    case "number":
      return "num";
    case "boolean":
      return "bool";
    case "object": {
      if (depth >= SIGNATURE_MAX_DEPTH) return "obj";
      try {
        const record = value as Record<string, unknown>;
        const keys = Object.keys(record).sort();
        const head = keys
          .slice(0, SIGNATURE_MAX_KEYS)
          .map((key) => `${key}:${typeTag(record[key], depth + 1)}`);
        if (keys.length > SIGNATURE_MAX_KEYS) {
          head.push(`…+${keys.length - SIGNATURE_MAX_KEYS}`);
        }
        return `{${head.join(",")}}`;
      } catch {
        return "obj";
      }
    }
    default:
      return "other";
  }
};

// Canonical argument-shape signature: sorted parameter names with a bounded
// value-type tag each. Key order and value contents never matter — only the
// shape the model chose.
export const shapeSignature = (args: Record<string, unknown>): string => {
  const keys = Object.keys(args).sort();
  const head = keys
    .slice(0, SIGNATURE_MAX_KEYS)
    .map((key) => `${key}:${typeTag(args[key], 1)}`);
  if (keys.length > SIGNATURE_MAX_KEYS) {
    head.push(`…+${keys.length - SIGNATURE_MAX_KEYS}`);
  }
  return `(${head.join(",")})`;
};

// Normalized Levenshtein distance between two signatures, in [0, 1]. Retry
// churn is the distance between a failed call's shape and the next attempt's.
export const signatureDistance = (left: string, right: string): number => {
  if (left === right) return 0;
  const bound = Math.max(left.length, right.length);
  if (bound === 0) return 0;
  let previous: number[] = [];
  for (let index = 0; index <= right.length; index++) {
    previous.push(index);
  }
  for (let index = 1; index <= left.length; index++) {
    const current: number[] = [index];
    for (let inner = 1; inner <= right.length; inner++) {
      const substitution = previous[inner - 1]! + (left[index - 1] === right[inner - 1] ? 0 : 1);
      const insertion = current[inner - 1]! + 1;
      const deletion = previous[inner]! + 1;
      current.push(Math.min(substitution, insertion, deletion));
    }
    previous = current;
  }
  return roundMetric(previous[right.length]! / bound);
};

// Shannon entropy in bits over a count distribution, rounded to 1e-6.
// A single class is zero bits; a uniform split over k classes is log2(k).
export const shannonEntropyBits = (counts: readonly number[]): number => {
  const total = counts.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return 0;
  let bits = 0;
  for (const count of counts) {
    if (count <= 0) continue;
    const probability = count / total;
    bits += probability * Math.log2(probability);
  }
  return roundMetric(-bits);
};

const schemaFreedom = (schema: unknown, depth: number): number => {
  if (depth > SIGNATURE_MAX_DEPTH) return 0.5;
  if (!isPlainRecord(schema)) return 0.5;
  const union = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : undefined;
  if (union) {
    const scores = union.map((branch) => schemaFreedom(branch, depth + 1));
    const widest = scores.length > 0 ? Math.max(...scores) : 0;
    return roundMetric(widest + 0.1 * Math.max(0, union.length - 1));
  }
  if (Array.isArray(schema.enum)) {
    return roundMetric(
      Math.min(1, Math.log2(Math.max(1, schema.enum.length)) / ENUM_SATURATION_BITS),
    );
  }
  if ("const" in schema) return 0;
  const type = schema.type;
  if (typeof type !== "string") return 0.75;
  if (type === "boolean") return 0.1;
  if (type === "number" || type === "integer") return 0.5;
  if (type === "string") return 1;
  if (type === "array") return roundMetric(0.5 + 0.5 * schemaFreedom(schema.items, depth + 1));
  if (type === "object") {
    const properties = schema.properties;
    if (!isPlainRecord(properties)) return 1;
    const keys = Object.keys(properties).sort();
    if (keys.length === 0) return 1;
    const required = Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === "string")
      : [];
    let score = 0;
    for (const key of keys) {
      score += schemaFreedom(properties[key], depth + 1);
      if (!required.includes(key)) score += 0.25;
    }
    if (schema.additionalProperties !== false) score += 0.5;
    return roundMetric(score);
  }
  return 0.75;
};

// Static freedom of one action's input schema: free strings dominate, enums
// shrink with log2 cardinality, literals cost nothing, and optional or
// open-ended parameters add tax. Computable with an empty corpus, which is
// what lets the compiler score candidate surfaces before deployment.
export const staticFreedomFromSchema = (schema: unknown): number => schemaFreedom(schema, 0);

// Least-squares slope of a score sequence, oldest to newest. The on-demand
// session trend feeds this per-session scores; a flat or negative slope is
// the ratchet holding.
export const trendFromScores = (scores: readonly number[]): EntropyTrend => {
  const count = scores.length;
  const first = count > 0 ? scores[0] : undefined;
  const last = count > 0 ? scores[count - 1] : undefined;
  let slope = 0;
  if (count >= 2) {
    const meanX = (count - 1) / 2;
    const meanY = scores.reduce((sum, value) => sum + value, 0) / count;
    let numerator = 0;
    let denominator = 0;
    for (let index = 0; index < count; index++) {
      numerator += (index - meanX) * (scores[index]! - meanY);
      denominator += (index - meanX) ** 2;
    }
    slope = denominator > 0 ? numerator / denominator : 0;
  }
  return {
    count,
    ...(first !== undefined ? { first: roundMetric(first) } : {}),
    ...(last !== undefined ? { last: roundMetric(last) } : {}),
    slopePerStep: roundMetric(slope),
  };
};
