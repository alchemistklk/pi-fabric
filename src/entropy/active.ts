// The active compiled surface, mirroring the active repair compiler: the
// runtime consults it at resolution, validation, and catalog time. Entries
// re-prove their recorded base digest against the live declared schema on
// every consult, so enforcement follows the live surface, never a stale
// snapshot.

import {
  effectiveSchemaFor,
  isQuarantinedRef,
  quarantinedRefNames,
  type CompiledSurfaceFile,
} from "./compiled-surface.js";

let active: CompiledSurfaceFile | undefined;

export const setActiveCompiledSurface = (file: CompiledSurfaceFile | undefined): void => {
  active = file;
};

export const clearActiveCompiledSurface = (): void => {
  active = undefined;
};

// The compiled schema replaces the declared schema while the recorded base
// digest still matches the live schema.
export const effectiveInputSchema = (ref: string, liveSchema: unknown): unknown =>
  effectiveSchemaFor(ref, liveSchema, active);

// Name-only quarantine view for catalog filtering and suggestions: hiding
// there is advisory, so no digest proof is required.
export const activeQuarantinedRefNames = (): ReadonlySet<string> => quarantinedRefNames(active);

// Digest-proofed quarantine denial for resolution.
export const isActiveQuarantine = (
  provider: string,
  actionName: string,
  liveSchema: unknown,
): boolean => isQuarantinedRef(`${provider}.${actionName}`, liveSchema, active);