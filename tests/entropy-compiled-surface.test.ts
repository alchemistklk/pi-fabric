import { describe, expect, it } from "vitest";
import {
  applyCompiledSurface,
  effectiveSchemaFor,
  isQuarantinedRef,
  quarantinedRefNames,
  replaySuccessfulCalls,
  schemaDigest,
  type CompiledSurfaceFile,
  type EntropySurfaceSnapshot,
  type EntropyTraceInput,
} from "../src/entropy/index.js";

const liveSurface = (): EntropySurfaceSnapshot => ({
  version: 1,
  actions: [
    {
      ref: "mcp.flaky.run",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["mode"],
        properties: { mode: { type: "string" } },
      },
    },
    {
      ref: "mcp.stale.old",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["x"],
        properties: { x: { type: "string" } },
      },
    },
    {
      ref: "memory.recall",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: { query: { type: "string" } },
      },
    },
  ],
});

const compiledArtifact = (live: EntropySurfaceSnapshot): CompiledSurfaceFile => {
  const recall = live.actions.find((action) => action.ref === "memory.recall")!;
  const flaky = live.actions.find((action) => action.ref === "mcp.flaky.run")!;
  return {
    version: 1,
    metricVersion: 2,
    actions: [
      {
        ref: "memory.recall",
        inputSchema: {
          ...(recall.inputSchema as Record<string, unknown>),
          properties: {
            query: { type: "string", enum: ["search", "expand", "recall"] },
          },
        },
        baseSchemaDigest: schemaDigest(recall.inputSchema),
      },
      // A stale overlay whose base no longer matches the live schema.
      {
        ref: "mcp.stale.old",
        inputSchema: { type: "object" },
        baseSchemaDigest: "0".repeat(64),
      },
    ],
    quarantined: [
      { ref: "mcp.flaky.run", baseSchemaDigest: schemaDigest(flaky.inputSchema) },
      // A stale quarantine entry must not hide the ref.
      { ref: "mcp.stale.old", baseSchemaDigest: "deadbeef" },
    ],
    applied: [{ kind: "enum-tighten", ref: "memory.recall", detail: "query: 3 observed values" }],
    gate: { passed: true, beforeScore: 0.25, afterScore: 0.18, reasons: [] },
    evidenceDigest: "abc123",
  };
};

const op = (
  ref: string,
  args: Record<string, unknown>,
  outcome: "succeeded" | "failed" = "succeeded",
): EntropyTraceInput["operations"][number] => ({ ref, args, outcome });

describe("compiled surface overlay", () => {
  it("applies digest-matched entries and drops stale ones", () => {
    const live = liveSurface();
    const liveJson = JSON.stringify(live);
    const effective = applyCompiledSurface(live, compiledArtifact(live));
    expect(JSON.stringify(live)).toBe(liveJson);
    expect(effective.actions.map((action) => action.ref)).toEqual([
      "mcp.stale.old",
      "memory.recall",
    ]);
    const recall = effective.actions.find((action) => action.ref === "memory.recall")!;
    const schema = recall.inputSchema as Record<string, unknown>;
    const query = (schema.properties as Record<string, { enum?: unknown[] }>).query;
    expect(query?.enum).toEqual(["search", "expand", "recall"]);
    const stale = effective.actions.find((action) => action.ref === "mcp.stale.old")!;
    expect(JSON.stringify(stale.inputSchema)).toBe(
      JSON.stringify(liveSurface().actions.find((a) => a.ref === "mcp.stale.old")!.inputSchema),
    );
  });

  it("returns the live surface untouched without an artifact", () => {
    const live = liveSurface();
    expect(applyCompiledSurface(live, undefined)).toBe(live);
    expect(effectiveSchemaFor("memory.recall", { type: "object" }, undefined)).toEqual({
      type: "object",
    });
  });

  it("consults the overlay per ref with digest proof", () => {
    const live = liveSurface();
    const file = compiledArtifact(live);
    const recallLive = live.actions.find((a) => a.ref === "memory.recall")!.inputSchema;
    expect(effectiveSchemaFor("memory.recall", recallLive, file)).toBe(
      file.actions[0]!.inputSchema,
    );
    const staleLive = live.actions.find((a) => a.ref === "mcp.stale.old")!.inputSchema;
    expect(effectiveSchemaFor("mcp.stale.old", staleLive, file)).toBe(staleLive);
  });

  it("denies quarantine only with digest proof", () => {
    const live = liveSurface();
    const file = compiledArtifact(live);
    const flakyLive = live.actions.find((a) => a.ref === "mcp.flaky.run")!.inputSchema;
    expect(isQuarantinedRef("mcp.flaky.run", flakyLive, file)).toBe(true);
    const staleLive = live.actions.find((a) => a.ref === "mcp.stale.old")!.inputSchema;
    expect(isQuarantinedRef("mcp.stale.old", staleLive, file)).toBe(false);
    expect(quarantinedRefNames(file)).toEqual(new Set(["mcp.flaky.run", "mcp.stale.old"]));
  });
});

describe("replay preservation", () => {
  it("checks only touched refs and skips failures", () => {
    const live = liveSurface();
    const file = compiledArtifact(live);
    const effective = applyCompiledSurface(live, file);
    const touched = new Set(["memory.recall", "mcp.flaky.run"]);
    const traces: EntropyTraceInput[] = [
      {
        operations: [
          op("memory.recall", { query: "search" }),
          op("memory.recall", { query: "bogus" }),
          op("memory.recall", { query: "anything" }, "failed"),
          op("mcp.flaky.run", { mode: "fast" }),
          op("mcp.stale.old", { totally: "wrong shape" }),
        ],
      },
    ];
    const violations = replaySuccessfulCalls(effective, traces, touched);
    expect(violations).toEqual([
      { ref: "memory.recall", reason: "recorded arguments no longer validate against the compiled schema" },
      { ref: "mcp.flaky.run", reason: "absent from the candidate surface" },
    ]);
  });
});