import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "../core/atomic-write.js";
import {
  emptyRepairTable,
  MAX_CATALOG_REPAIRS,
  REPAIR_TABLE_VERSION,
  repairIdentity,
  type CatalogRepair,
  type RepairTableFile,
} from "./types.js";

const REPAIR_LOCK_ATTEMPTS = 50;
const REPAIR_LOCK_DELAY_MS = 5;
const REPAIR_STALE_LOCK_MS = 30_000;

export const repairsDirectory = (agentDir: string): string =>
  path.join(agentDir, "fabric", "repairs");

const currentPath = (directory: string): string => path.join(directory, "current.json");
const lockPath = (directory: string): string => path.join(directory, "current.lock");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const errorCode = (error: unknown): string | undefined =>
  isRecord(error) && typeof error.code === "string" ? error.code : undefined;

const sleepSync = (() => {
  try {
    const buffer = new Int32Array(new SharedArrayBuffer(4));
    return (ms: number): void => {
      Atomics.wait(buffer, 0, 0, ms);
    };
  } catch {
    return (): void => undefined;
  }
})();

const parseRepair = (value: unknown): CatalogRepair | undefined | "skip" => {
  if (!isRecord(value) || typeof value.kind !== "string") return undefined;
  if (value.kind === "keyAlias") {
    if (
      typeof value.ref !== "string" ||
      typeof value.from !== "string" ||
      typeof value.to !== "string" ||
      !value.ref.trim() ||
      !value.from.trim() ||
      !value.to.trim()
    ) {
      return undefined;
    }
    return { kind: "keyAlias", ref: value.ref.trim(), from: value.from.trim(), to: value.to.trim() };
  }
  if (value.kind === "actionAlias") {
    if (
      typeof value.provider !== "string" ||
      typeof value.from !== "string" ||
      typeof value.to !== "string" ||
      !value.provider.trim() ||
      !value.from.trim() ||
      !value.to.trim()
    ) {
      return undefined;
    }
    return {
      kind: "actionAlias",
      provider: value.provider.trim(),
      from: value.from.trim(),
      to: value.to.trim(),
    };
  }
  return "skip";
};

const parseRepairTable = (value: unknown): RepairTableFile | undefined => {
  if (!isRecord(value) || value.version !== REPAIR_TABLE_VERSION) return undefined;
  if (typeof value.catalogDigest !== "string" || !value.catalogDigest.trim()) return undefined;
  if (!Array.isArray(value.repairs) || value.repairs.length > MAX_CATALOG_REPAIRS) return undefined;
  const repairs: CatalogRepair[] = [];
  const identities = new Set<string>();
  for (const entry of value.repairs) {
    const parsed = parseRepair(entry);
    if (parsed === "skip") continue;
    if (!parsed) return undefined;
    const identity = repairIdentity(parsed);
    if (identities.has(identity)) continue;
    identities.add(identity);
    repairs.push(parsed);
  }
  if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") return undefined;
  return {
    version: REPAIR_TABLE_VERSION,
    catalogDigest: value.catalogDigest.trim(),
    repairs,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
};

const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 200);

const writeTable = (file: string, table: RepairTableFile): void => {
  writeJsonAtomic(file, table, { space: 2, newline: true, mode: 0o600, dirMode: 0o700 });
};

const processAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Stale-lock recovery must be an exclusive claim. Stat-then-delete is
// TOCTOU: two reapers (or a reaper and a fresh writer that recreated the
// lock in between) can both pass their checks, and the slower rm then
// deletes a lock the faster one already replaced. rename() is the claim —
// only one process can move the directory, and removal targets the claimed
// path, never the live lock path. A claim that turns out to hold a live
// lock is renamed back before any destructive step; a live lock is never
// deleted, even if the rename-back races a fresh writer.
const reapStaleLock = (lock: string, verify: (claimed: string) => boolean): boolean => {
  const claim = `${lock}.reap-${process.pid}-${randomUUID()}`;
  try {
    fs.renameSync(lock, claim);
  } catch {
    return false;
  }
  if (!verify(claim)) {
    try {
      fs.renameSync(claim, lock);
    } catch {
      // `lock` was recreated after the claim. Re-verify before any
      // destructive step so a claimed live lock is only ever abandoned as
      // garbage, never deleted.
      if (verify(claim)) fs.rmSync(claim, { recursive: true, force: true });
    }
    return false;
  }
  fs.rmSync(claim, { recursive: true, force: true });
  return true;
};

// Shared agent-dir store lock: the repairs table and the entropy ledger
// both serialize their read-modify-write cycles through this directory lock.
export const withRepairLock = <T>(directory: string, operation: () => T): T => {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = lockPath(directory);
  const ownerPath = path.join(lock, "owner");
  const token = randomUUID();
  let acquired = false;
  for (let attempt = 0; attempt < REPAIR_LOCK_ATTEMPTS; attempt++) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      try {
        fs.writeFileSync(ownerPath, `${token}\n${process.pid}\n${Date.now()}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
      } catch (error) {
        fs.rmSync(lock, { recursive: true, force: true });
        throw error;
      }
      acquired = true;
      break;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      try {
        const firstOwner = fs.readFileSync(ownerPath, "utf8");
        const [, pidText, createdText] = firstOwner.trim().split("\n");
        const stale = Date.now() - Number(createdText) > REPAIR_STALE_LOCK_MS;
        if (stale && !processAlive(Number(pidText))) {
          const secondOwner = fs.readFileSync(ownerPath, "utf8");
          if (
            secondOwner === firstOwner &&
            reapStaleLock(lock, (claimed) => {
              try {
                const owner = fs.readFileSync(path.join(claimed, "owner"), "utf8");
                const [, pid, created] = owner.trim().split("\n");
                return (
                  Date.now() - Number(created) > REPAIR_STALE_LOCK_MS &&
                  !processAlive(Number(pid))
                );
              } catch {
                return false;
              }
            })
          ) {
            continue;
          }
        }
      } catch {
        try {
          // Ownerless lock (crash between mkdir and the owner write): age is
          // the only signal, and the claim re-verifies it after the rename.
          const first = fs.statSync(lock);
          if (
            Date.now() - first.mtimeMs > REPAIR_STALE_LOCK_MS &&
            reapStaleLock(lock, (claimed) => {
              try {
                return Date.now() - fs.statSync(claimed).mtimeMs > REPAIR_STALE_LOCK_MS;
              } catch {
                return false;
              }
            })
          ) {
            continue;
          }
        } catch {
          // Lock creation or stale recovery raced; retry the bounded acquisition.
        }
      }
      if (attempt === REPAIR_LOCK_ATTEMPTS - 1) break;
      sleepSync(REPAIR_LOCK_DELAY_MS);
    }
  }
  if (!acquired) throw new Error("Timed out waiting for the Fabric repair table lock");
  try {
    return operation();
  } finally {
    try {
      const owner = fs.readFileSync(ownerPath, "utf8");
      if (owner.startsWith(`${token}\n`)) {
        fs.rmSync(lock, { recursive: true, force: true });
      }
    } catch {
      // A recovering process already removed this lock.
    }
  }
};

export interface LoadedRepairTable {
  table: RepairTableFile;
  error?: string;
}

export const loadRepairTable = (
  directory: string,
  catalogDigest: string,
): LoadedRepairTable => {
  const file = currentPath(directory);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    // A missing table is a fresh start; anything else (unreadable, wrong
    // type) is damage that callers must surface, not silently rebuild.
    if (errorCode(error) === "ENOENT") return { table: emptyRepairTable(catalogDigest) };
    return {
      table: emptyRepairTable(catalogDigest),
      error: `repair table is unreadable: ${errorText(error)}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { table: emptyRepairTable(catalogDigest), error: "repair table is malformed JSON" };
  }
  const table = parseRepairTable(parsed);
  if (!table) {
    return { table: emptyRepairTable(catalogDigest), error: "repair table is invalid" };
  }
  // A table persisted under a different digest is the accepted catalog
  // replacement contract: start fresh, without an error.
  if (table.catalogDigest !== catalogDigest) return { table: emptyRepairTable(catalogDigest) };
  return { table };
};

export const saveRepairTable = (
  directory: string,
  table: RepairTableFile,
): RepairTableFile =>
  withRepairLock(directory, () => {
    const loaded = loadRepairTable(directory, table.catalogDigest);
    // A damaged table must never be silently rebuilt: merging from empty
    // would overwrite the user's data. Fail so promotion records the reason
    // in status().storeError and leaves the file untouched for recovery.
    if (loaded.error) throw new Error(loaded.error);
    const persisted = loaded.table;
    const repairs: CatalogRepair[] = [];
    const identities = new Set<string>();
    for (const repair of [...persisted.repairs, ...table.repairs]) {
      const identity = repairIdentity(repair);
      if (identities.has(identity)) continue;
      if (repairs.length >= MAX_CATALOG_REPAIRS) break;
      identities.add(identity);
      repairs.push(repair);
    }
    const now = new Date().toISOString();
    const merged: RepairTableFile = {
      version: REPAIR_TABLE_VERSION,
      catalogDigest: table.catalogDigest,
      repairs,
      createdAt: persisted.repairs.length > 0 ? persisted.createdAt : table.createdAt,
      updatedAt: now,
    };
    writeTable(currentPath(directory), merged);
    return merged;
  });
