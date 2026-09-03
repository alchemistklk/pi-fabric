import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "../core/atomic-write.js";
import { withRepairLock } from "../repairs/store.js";
import {
  ENTROPY_LEDGER_VERSION,
  ENTROPY_METRIC_VERSION,
  MAX_ENTROPY_LEDGER_ENTRIES,
  type EntropyLedgerEntry,
  type EntropyLedgerFile,
  type EntropyTrend,
} from "./types.js";
import { roundMetric } from "./fingerprint.js";

// The entropy ledger persists the measured score per certification run,
// alongside the repair table under the agent directory. Appends are
// lock-serialized through the shared agent-dir store lock. A damaged ledger
// surfaces as an error and is never silently rebuilt, mirroring the repair
// table contract.

export const entropyDirectory = (agentDir: string): string =>
  path.join(agentDir, "fabric", "entropy");

const ledgerPath = (directory: string): string => path.join(directory, "ledger.json");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const errorCode = (error: unknown): string | undefined =>
  isRecord(error) && typeof error.code === "string" ? error.code : undefined;

const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 200);

const isValidEntry = (value: unknown): value is EntropyLedgerEntry => {
  if (!isRecord(value)) return false;
  const catalogDigest = value.catalogDigest;
  const metricVersion = value.metricVersion;
  const score = value.score;
  const operations = value.operations;
  const invocationRejectionsPer1k = value.invocationRejectionsPer1k;
  const source = value.source;
  const createdAt = value.createdAt;
  return (
    typeof catalogDigest === "string" &&
    typeof metricVersion === "number" &&
    typeof score === "number" &&
    Number.isFinite(score) &&
    typeof operations === "number" &&
    Number.isSafeInteger(operations) &&
    operations >= 0 &&
    typeof invocationRejectionsPer1k === "number" &&
    Number.isFinite(invocationRejectionsPer1k) &&
    invocationRejectionsPer1k >= 0 &&
    typeof source === "string" &&
    source.length > 0 &&
    typeof createdAt === "string"
  );
};

const parseLedger = (value: unknown): EntropyLedgerFile | undefined => {
  if (!isRecord(value) || value.version !== ENTROPY_LEDGER_VERSION) return undefined;
  if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") return undefined;
  if (!Array.isArray(value.entries) || value.entries.length > MAX_ENTROPY_LEDGER_ENTRIES) {
    return undefined;
  }
  const entries: EntropyLedgerEntry[] = [];
  for (const entry of value.entries) {
    if (!isValidEntry(entry)) return undefined;
    entries.push(entry);
  }
  return {
    version: ENTROPY_LEDGER_VERSION,
    entries,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
};

export const emptyEntropyLedger = (now: string): EntropyLedgerFile => ({
  version: ENTROPY_LEDGER_VERSION,
  entries: [],
  createdAt: now,
  updatedAt: now,
});

export interface LoadedEntropyLedger {
  ledger: EntropyLedgerFile;
  error?: string;
}

export const loadEntropyLedger = (directory: string): LoadedEntropyLedger => {
  let raw: string;
  try {
    raw = fs.readFileSync(ledgerPath(directory), "utf8");
  } catch (error) {
    const fresh = emptyEntropyLedger(new Date().toISOString());
    if (errorCode(error) === "ENOENT") return { ledger: fresh };
    return { ledger: fresh, error: `entropy ledger is unreadable: ${errorText(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ledger: emptyEntropyLedger(new Date().toISOString()),
      error: "entropy ledger is malformed JSON",
    };
  }
  const ledger = parseLedger(parsed);
  if (!ledger) {
    return {
      ledger: emptyEntropyLedger(new Date().toISOString()),
      error: "entropy ledger is invalid",
    };
  }
  return { ledger };
};

export interface EntropyLedgerEntryInput {
  catalogDigest: string;
  score: number;
  operations: number;
  invocationRejectionsPer1k: number;
  source: string;
}

export const appendEntropyLedgerEntry = (
  directory: string,
  entry: EntropyLedgerEntryInput,
): EntropyLedgerFile =>
  withRepairLock(directory, () => {
    if (typeof entry.catalogDigest !== "string" || entry.catalogDigest.length === 0) {
      throw new Error("entropy ledger entry requires a catalog digest");
    }
    if (!Number.isFinite(entry.score) || entry.score < 0) {
      throw new Error("entropy ledger entry requires a finite score");
    }
    if (!Number.isSafeInteger(entry.operations) || entry.operations < 0) {
      throw new Error("entropy ledger entry requires a nonnegative operation count");
    }
    if (!Number.isFinite(entry.invocationRejectionsPer1k) || entry.invocationRejectionsPer1k < 0) {
      throw new Error("entropy ledger entry requires a nonnegative rejection rate");
    }
    if (typeof entry.source !== "string" || entry.source.length === 0) {
      throw new Error("entropy ledger entry requires a source");
    }
    const loaded = loadEntropyLedger(directory);
    // A damaged ledger must never be silently rebuilt: appends fail so the
    // file stays untouched for recovery, exactly like the repair table.
    if (loaded.error) throw new Error(loaded.error);
    const now = new Date().toISOString();
    const next: EntropyLedgerEntry = {
      catalogDigest: entry.catalogDigest,
      metricVersion: ENTROPY_METRIC_VERSION,
      score: entry.score,
      operations: entry.operations,
      invocationRejectionsPer1k: entry.invocationRejectionsPer1k,
      source: entry.source,
      createdAt: now,
    };
    const entries = [...loaded.ledger.entries, next];
    const trimmed =
      entries.length > MAX_ENTROPY_LEDGER_ENTRIES
        ? entries.slice(entries.length - MAX_ENTROPY_LEDGER_ENTRIES)
        : entries;
    const ledger: EntropyLedgerFile = {
      version: ENTROPY_LEDGER_VERSION,
      entries: trimmed,
      createdAt: loaded.ledger.entries.length > 0 ? loaded.ledger.createdAt : now,
      updatedAt: now,
    };
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeJsonAtomic(ledgerPath(directory), ledger, {
      space: 2,
      newline: true,
      mode: 0o600,
      dirMode: 0o700,
    });
    return ledger;
  });

// Least-squares score slope per ledger entry — the trend line the ratchet
// must keep pointing down.
export const entropyTrend = (ledger: EntropyLedgerFile): EntropyTrend => {
  const scores = ledger.entries.map((entry) => entry.score);
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
    ...(first !== undefined ? { firstScore: roundMetric(first) } : {}),
    ...(last !== undefined ? { lastScore: roundMetric(last) } : {}),
    slopePerEntry: roundMetric(slope),
  };
};
