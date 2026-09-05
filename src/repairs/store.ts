import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic, writeJsonAtomicAsync } from "../core/atomic-write.js";
import { withExclusiveFileLock, withExclusiveFileLockAsync } from "../core/file-lock.js";
import {
  emptyRepairTable,
  MAX_CATALOG_REPAIRS,
  REPAIR_TABLE_VERSION,
  repairIdentity,
  type CatalogRepair,
  type RepairTableFile,
} from "./types.js";

const LOCK_TIMEOUT_MESSAGE = "Timed out waiting for the Fabric repair table lock";

export const repairsDirectory = (agentDir: string): string =>
  path.join(agentDir, "fabric", "repairs");

const currentPath = (directory: string): string => path.join(directory, "current.json");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const errorCode = (error: unknown): string | undefined =>
  isRecord(error) && typeof error.code === "string" ? error.code : undefined;

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

const loadRepairTableAsync = async (
  directory: string,
  catalogDigest: string,
): Promise<LoadedRepairTable> => {
  const file = currentPath(directory);
  let raw: string;
  try {
    raw = await fs.promises.readFile(file, "utf8");
  } catch (error) {
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
  return table.catalogDigest === catalogDigest
    ? { table }
    : { table: emptyRepairTable(catalogDigest) };
};

export const saveRepairTable = (
  directory: string,
  table: RepairTableFile,
): RepairTableFile =>
  withExclusiveFileLock(
    { directory, lockName: "current.lock", timeoutMessage: LOCK_TIMEOUT_MESSAGE },
    () => {
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
    },
  );

export const saveRepairTableAsync = async (
  directory: string,
  table: RepairTableFile,
): Promise<RepairTableFile> =>
  withExclusiveFileLockAsync(
    { directory, lockName: "current.lock", timeoutMessage: LOCK_TIMEOUT_MESSAGE },
    async () => {
      const loaded = await loadRepairTableAsync(directory, table.catalogDigest);
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
      await writeJsonAtomicAsync(currentPath(directory), merged, {
        space: 2,
        newline: true,
        mode: 0o600,
        dirMode: 0o700,
      });
      return merged;
    },
  );
