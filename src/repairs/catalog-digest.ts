import { stableJsonHash } from "../core/stable-hash.js";

export const catalogDigestFromSurface = (surface: {
  providers: readonly string[];
  capturedTools: readonly string[];
}): string =>
  stableJsonHash({
    v: 1,
    providers: [...surface.providers].sort(),
    captured: [...surface.capturedTools].sort(),
  });
