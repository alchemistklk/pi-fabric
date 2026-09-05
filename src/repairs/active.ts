import type { RepairCompiler } from "./compiler.js";

let active: RepairCompiler | undefined;

export const setActiveRepairCompiler = (compiler: RepairCompiler | undefined): void => {
  active = compiler;
};

export const clearActiveRepairCompiler = (compiler: RepairCompiler | undefined): void => {
  if (compiler && active === compiler) active = undefined;
};

export const getActiveRepairCompiler = (): RepairCompiler | undefined => active;

export const applyActiveArgRepairs = (
  ref: string,
  args: Record<string, unknown>,
  schema: Record<string, unknown>,
): Record<string, unknown> => active?.applyArgs(ref, args, schema) ?? args;

export const applyActiveActionName = (
  provider: string,
  actionName: string,
  declared: readonly string[],
): string => active?.applyActionName(provider, actionName, declared) ?? actionName;
