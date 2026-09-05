import { uniqueDeclaredKeyForSpelling } from "../providers/arg-normalization.js";
import { repairActionName } from "../core/action-repair.js";
import type { CatalogRepair } from "./types.js";

export const keyAliasCandidate = (
  ref: string,
  extraKeys: readonly string[],
  declared: readonly string[],
): CatalogRepair | undefined => {
  if (extraKeys.length !== 1) return undefined;
  const from = extraKeys[0]!;
  const to = uniqueDeclaredKeyForSpelling(from, declared);
  if (!to) return undefined;
  return { kind: "keyAlias", ref, from, to };
};

export const actionAliasCandidate = (
  provider: string,
  actionName: string,
  declared: readonly string[],
): CatalogRepair | undefined => {
  const repair = repairActionName(declared, actionName);
  if (!repair.repaired || repair.repaired === actionName) return undefined;
  return {
    kind: "actionAlias",
    provider,
    from: actionName,
    to: repair.repaired,
  };
};
