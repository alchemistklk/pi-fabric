import { describe, expect, it } from "vitest";
import {
  mergeCompiledSurfaces,
  schemaDigest,
  type CompiledSurfaceFile,
  type EntropySurfaceSnapshot,
} from "../src/entropy/index.js";

const schemaA = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
const schemaB = { type: "object", properties: { b: { type: "integer" } }, required: ["b"] };
const schemaC = { type: "object", properties: { c: { type: "string" } }, required: ["c"] };
const schemaD = { type: "object", properties: { d: { type: "string" } }, required: ["d"] };
const schemaE = { type: "object", properties: { e: { type: "string" } }, required: ["e"] };

const live = (): EntropySurfaceSnapshot => ({
  version: 1,
  actions: [
    { ref: "demo.a", inputSchema: schemaA },
    { ref: "demo.b", inputSchema: schemaB },
    { ref: "demo.c", inputSchema: schemaC },
    { ref: "demo.d", inputSchema: schemaD },
    { ref: "demo.e", inputSchema: schemaE },
  ],
});

const baseArtifact = (overrides: Partial<CompiledSurfaceFile>): CompiledSurfaceFile => ({
  version: 1,
  metricVersion: 2,
  actions: [],
  quarantined: [],
  applied: [],
  gate: { passed: true, beforeScore: 0.3, afterScore: 0.2, reasons: [] },
  evidenceDigest: "base",
  ...overrides,
});

const overlay = (ref: string, schema: unknown, digestOf: unknown) => ({
  ref,
  inputSchema: schema as Record<string, unknown>,
  baseSchemaDigest: schemaDigest(digestOf),
});

describe("mergeCompiledSurfaces", () => {
  it("adopts proven incoming entries where the local artifact is silent", () => {
    const local = baseArtifact({
      actions: [overlay("demo.a", schemaA, schemaA)],
      applied: [{ kind: "enum-tighten", ref: "demo.a", detail: "a: 2 observed values" }],
    });
    const incoming = baseArtifact({
      evidenceDigest: "peer",
      actions: [
        overlay("demo.a", { ...schemaA, tight: true }, schemaA),
        overlay("demo.b", schemaB, schemaB),
        overlay("demo.d", schemaD, { changed: true }),
      ],
      quarantined: [
        { ref: "demo.c", baseSchemaDigest: schemaDigest(schemaC) },
        { ref: "demo.e", baseSchemaDigest: schemaDigest({ stale: true }) },
      ],
      applied: [
        { kind: "enum-tighten", ref: "demo.a", detail: "a: 2 observed values" },
        { kind: "noise-quarantine", ref: "demo.c", detail: "3 failed vs 0 succeeded" },
      ],
    });
    const merged = mergeCompiledSurfaces(local, incoming, live());
    expect(merged.file.actions.map((entry) => entry.ref)).toEqual(["demo.a", "demo.b"]);
    expect(merged.file.actions[0]!.inputSchema).toEqual(schemaA);
    expect(merged.file.quarantined.map((entry) => entry.ref)).toEqual(["demo.c"]);
    expect(merged.droppedOverlays).toBe(1);
    expect(merged.droppedQuarantines).toBe(1);
    expect(merged.file.applied).toEqual([
      { kind: "enum-tighten", ref: "demo.a", detail: "a: 2 observed values" },
      { kind: "noise-quarantine", ref: "demo.c", detail: "3 failed vs 0 succeeded" },
    ]);
  });

  it("adopts a full incoming artifact when no local artifact exists", () => {
    const incoming = baseArtifact({
      evidenceDigest: "peer",
      actions: [overlay("demo.b", schemaB, schemaB)],
      quarantined: [{ ref: "demo.c", baseSchemaDigest: schemaDigest(schemaC) }],
      applied: [{ kind: "noise-quarantine", ref: "demo.c", detail: "3 failed vs 0 succeeded" }],
    });
    const merged = mergeCompiledSurfaces(undefined, incoming, live());
    expect(merged.file.actions).toHaveLength(1);
    expect(merged.file.quarantined).toHaveLength(1);
    expect(merged.file.metricVersion).toBe(2);
    expect(merged.file.gate).toEqual(incoming.gate);
    expect(merged.droppedOverlays).toBe(0);
    expect(merged.droppedQuarantines).toBe(0);
  });

  it("skips incoming overlays for refs the local artifact quarantines", () => {
    const local = baseArtifact({
      quarantined: [{ ref: "demo.b", baseSchemaDigest: schemaDigest(schemaB) }],
    });
    const incoming = baseArtifact({
      actions: [overlay("demo.b", schemaB, schemaB)],
    });
    const merged = mergeCompiledSurfaces(local, incoming, live());
    expect(merged.file.actions).toEqual([]);
    expect(merged.file.quarantined.map((entry) => entry.ref)).toEqual(["demo.b"]);
  });

  it("is deterministic for identical inputs", () => {
    const local = baseArtifact({ actions: [overlay("demo.a", schemaA, schemaA)] });
    const incoming = baseArtifact({
      evidenceDigest: "peer",
      actions: [overlay("demo.b", schemaB, schemaB)],
    });
    const first = mergeCompiledSurfaces(local, incoming, live());
    const second = mergeCompiledSurfaces(local, incoming, live());
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
