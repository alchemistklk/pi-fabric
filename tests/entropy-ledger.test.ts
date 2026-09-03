import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendEntropyLedgerEntry,
  entropyDirectory,
  entropyTrend,
  loadEntropyLedger,
  MAX_ENTROPY_LEDGER_ENTRIES,
} from "../src/entropy/index.js";

const tmpRoots: string[] = [];
const makeTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-entropy-"));
  tmpRoots.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of tmpRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const entry = (score: number) => ({
  catalogDigest: "digest-test",
  score,
  operations: 10,
  invocationRejectionsPer1k: 0,
  source: "certify-entropy",
});

describe("entropy ledger", () => {
  it("lives beside the repair table under the agent directory", () => {
    expect(entropyDirectory("/tmp/agent")).toBe(
      path.join("/tmp/agent", "fabric", "entropy"),
    );
  });

  it("starts fresh on a missing file", () => {
    const loaded = loadEntropyLedger(makeTempDir());
    expect(loaded.error).toBeUndefined();
    expect(loaded.ledger.entries).toEqual([]);
  });

  it("round trips entries with an exact trend slope", () => {
    const dir = makeTempDir();
    for (const score of [0.6, 0.4, 0.2]) appendEntropyLedgerEntry(dir, entry(score));
    const loaded = loadEntropyLedger(dir);
    expect(loaded.error).toBeUndefined();
    expect(loaded.ledger.entries).toHaveLength(3);
    const trend = entropyTrend(loaded.ledger);
    expect(trend.slopePerEntry).toBe(-0.2);
    expect(trend.lastScore).toBe(0.2);
    expect(trend.firstScore).toBe(0.6);
    expect(trend.count).toBe(3);
  });

  it("caps the ledger at MAX_ENTROPY_LEDGER_ENTRIES keeping the newest", () => {
    const dir = makeTempDir();
    for (let index = 0; index < MAX_ENTROPY_LEDGER_ENTRIES + 10; index++) {
      appendEntropyLedgerEntry(dir, entry(index));
    }
    const loaded = loadEntropyLedger(dir);
    expect(loaded.ledger.entries).toHaveLength(MAX_ENTROPY_LEDGER_ENTRIES);
    expect(loaded.ledger.entries[MAX_ENTROPY_LEDGER_ENTRIES - 1]?.score).toBe(
      MAX_ENTROPY_LEDGER_ENTRIES + 9,
    );
  });

  it("rejects invalid entry fields", () => {
    const dir = makeTempDir();
    expect(() =>
      appendEntropyLedgerEntry(dir, { ...entry(1), catalogDigest: "" }),
    ).toThrow();
    expect(() =>
      appendEntropyLedgerEntry(dir, { ...entry(1), score: Number.NaN }),
    ).toThrow();
    expect(() =>
      appendEntropyLedgerEntry(dir, { ...entry(1), operations: -1 }),
    ).toThrow();
    expect(() =>
      appendEntropyLedgerEntry(dir, { ...entry(1), source: "" }),
    ).toThrow();
  });

  it("surfaces a damaged ledger and never overwrites it", () => {
    const dir = makeTempDir();
    appendEntropyLedgerEntry(dir, entry(1));
    const file = path.join(dir, "ledger.json");
    fs.writeFileSync(file, "{oops", "utf8");
    const damaged = loadEntropyLedger(dir);
    expect(damaged.error).toBe("entropy ledger is malformed JSON");
    expect(() => appendEntropyLedgerEntry(dir, entry(2))).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe("{oops");
  });
});
