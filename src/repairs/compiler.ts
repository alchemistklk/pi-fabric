import { applyActionAliasRepairs, applyCatalogArgRepairs } from "./apply.js";
import { catalogDigestFromSurface } from "./catalog-digest.js";
import { actionAliasCandidate, keyAliasCandidate } from "./promote.js";
import { loadRepairTable, repairsDirectory, saveRepairTable } from "./store.js";
import {
  emptyRepairTable,
  MAX_CATALOG_REPAIRS,
  repairIdentity,
  type CatalogRepair,
  type RepairClassification,
  type RepairStage,
  type RepairStatus,
  type RepairTableFile,
} from "./types.js";

export interface RepairCompilerOptions {
  agentDir: string;
  enabled?: boolean;
}

interface FingerprintState {
  stage: RepairStage;
  count: number;
  candidate?: CatalogRepair;
}

const errorMessage = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 240);

export class RepairCompiler {
  readonly directory: string;
  readonly enabled: boolean;
  #digest = "";
  #table: RepairTableFile;
  #counts = new Map<string, FingerprintState>();
  #applyHits = 0;
  #invocationErrors = 0;
  #effectDropped = 0;
  #storeError: string | undefined;

  constructor(options: RepairCompilerOptions) {
    this.directory = repairsDirectory(options.agentDir);
    this.enabled = options.enabled !== false;
    this.#table = emptyRepairTable("");
  }

  get catalogDigest(): string {
    return this.#digest;
  }

  get repairs(): readonly CatalogRepair[] {
    return this.#table.repairs;
  }

  setCatalogSurface(surface: {
    providers: readonly string[];
    capturedTools: readonly string[];
  }): void {
    const digest = catalogDigestFromSurface(surface);
    if (digest === this.#digest && this.#table.catalogDigest === digest) return;
    this.#digest = digest;
    if (!this.enabled) {
      this.#table = emptyRepairTable(digest);
      this.#storeError = undefined;
    } else {
      const loaded = loadRepairTable(this.directory, digest);
      this.#table = loaded.table;
      // Missing or different-digest tables start fresh; an unreadable or
      // malformed table is surfaced and blocks promotion from overwriting it.
      this.#storeError = loaded.error;
    }
    this.#counts.clear();
  }

  observe(
    classification: RepairClassification,
    options?: { countError?: boolean },
  ): CatalogRepair | undefined {
    if (classification.stage === "effect") {
      this.#effectDropped += 1;
      return undefined;
    }
    if (options?.countError !== false) this.#invocationErrors += 1;
    const existing = this.#counts.get(classification.fingerprint);
    const candidate = classification.candidate ?? existing?.candidate;
    const next: FingerprintState = {
      stage: classification.stage,
      count: (existing?.count ?? 0) + 1,
      ...(candidate ? { candidate } : {}),
    };
    this.#counts.set(classification.fingerprint, next);
    if (!this.enabled || !next.candidate) return undefined;
    return this.#promote(next.candidate);
  }

  recordInvocationError(): void {
    this.#invocationErrors += 1;
  }

  observeInvalidArgs(
    ref: string,
    args: Record<string, unknown>,
    declared: readonly string[],
    message: string,
    options?: { countError?: boolean; extraKeys?: readonly string[] },
  ): CatalogRepair | undefined {
    const extra = options?.extraKeys ??
      Object.keys(args).filter((key) => !declared.includes(key));
    const candidate = keyAliasCandidate(ref, extra, declared);
    return this.observe(
      {
        stage: "invocation_args",
        fingerprint: extra[0] ? `args:${ref}:${extra[0]}` : `args:${ref}:${message.slice(0, 80)}`,
        ...(candidate ? { candidate } : {}),
      },
      options,
    );
  }

  observeUnknownAction(
    provider: string,
    actionName: string,
    declared: readonly string[],
    options?: { countError?: boolean },
  ): CatalogRepair | undefined {
    const candidate = actionAliasCandidate(provider, actionName, declared);
    return this.observe(
      {
        stage: "invocation_unknown_action",
        fingerprint: `unknown:${provider}.${actionName}`,
        ...(candidate ? { candidate } : {}),
      },
      options,
    );
  }

  applyArgs(
    ref: string,
    args: Record<string, unknown>,
    schema: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!this.enabled || this.#table.repairs.length === 0) return args;
    const result = applyCatalogArgRepairs(ref, args, this.#table.repairs, schema);
    if (result.changed) this.#applyHits += 1;
    return result.args;
  }

  applyActionName(
    provider: string,
    actionName: string,
    declared: readonly string[],
  ): string {
    if (!this.enabled || this.#table.repairs.length === 0) return actionName;
    const repaired = applyActionAliasRepairs(
      provider,
      actionName,
      this.#table.repairs,
      declared,
    );
    if (repaired && repaired !== actionName) {
      this.#applyHits += 1;
      return repaired;
    }
    return actionName;
  }

  status(): RepairStatus {
    const fingerprints = [...this.#counts.entries()]
      .map(([fingerprint, state]) => ({
        fingerprint,
        stage: state.stage,
        count: state.count,
      }))
      .sort((left, right) => right.count - left.count || left.fingerprint.localeCompare(right.fingerprint))
      .slice(0, 20);
    return {
      enabled: this.enabled,
      catalogDigest: this.#digest,
      repairCount: this.#table.repairs.length,
      applyHits: this.#applyHits,
      invocationErrors: this.#invocationErrors,
      effectDropped: this.#effectDropped,
      ...(this.#storeError ? { storeError: this.#storeError } : {}),
      fingerprints,
      repairs: [...this.#table.repairs],
    };
  }

  #promote(candidate: CatalogRepair): CatalogRepair | undefined {
    if (!this.#digest) return undefined;
    const identity = repairIdentity(candidate);
    if (this.#table.repairs.some((repair) => repairIdentity(repair) === identity)) {
      if (this.#storeError) this.#persist(this.#table);
      return undefined;
    }
    if (this.#table.repairs.length >= MAX_CATALOG_REPAIRS) return undefined;
    const now = new Date().toISOString();
    const next: RepairTableFile = {
      ...this.#table,
      catalogDigest: this.#digest || this.#table.catalogDigest,
      repairs: [...this.#table.repairs, candidate],
      updatedAt: now,
      createdAt: this.#table.createdAt || now,
    };
    const saved = this.#persist(next);
    if (!saved) return candidate;
    return saved.repairs.some((repair) => repairIdentity(repair) === identity)
      ? candidate
      : undefined;
  }

  #persist(table: RepairTableFile): RepairTableFile | undefined {
    try {
      this.#table = saveRepairTable(this.directory, table);
      this.#storeError = undefined;
      return this.#table;
    } catch (error) {
      this.#table = table;
      this.#storeError = errorMessage(error);
      return undefined;
    }
  }
}
