import { describe, expect, it } from "vitest";
import {
  applyProposalsToSurface,
  evaluateGate,
  measureEntropy,
  proposeEntropyReductions,
  type EntropyOperationInput,
  type EntropySurfaceSnapshot,
  type EntropyTraceInput,
} from "../src/entropy/index.js";

const op = (
  ref: string,
  args: Record<string, unknown>,
  outcome: "succeeded" | "failed" = "succeeded",
  failureStage?: string,
): EntropyOperationInput => ({
  ref,
  args,
  outcome,
  ...(failureStage ? { failureStage } : {}),
});

const trace = (
  operations: EntropyOperationInput[],
  taskKey?: string,
): EntropyTraceInput => ({
  operations,
  ...(taskKey ? { taskKey } : {}),
});

const surfaceOf = (actions: Array<{ ref: string; inputSchema: unknown }>): EntropySurfaceSnapshot => ({
  version: 1,
  actions,
});

const ratchetTraces = (): EntropyTraceInput[] => [
  trace(
    [
      op("mcp.report.render", { format: "pdf" }),
      op("mcp.report.render", { format: "pdf" }),
      op("mcp.report.render", { format: "pdf" }),
      op("mcp.report.render", { format: "pdf" }),
      op("mcp.report.render", { format: "pdf" }),
      op("mcp.report.render", { format: "pdf" }),
      op("mcp.report.render", { format: "pdf" }),
      op("mcp.report.render", { format: "html" }),
    ],
    "ratchet",
  ),
  trace(
    [
      op("mcp.flaky.run", { mode: "fast" }, "failed", "validate"),
      op("mcp.flaky.run", { mode: "slow" }, "failed", "invoke"),
      op("mcp.flaky.run", { mode: "fast" }, "failed", "validate"),
      op("mcp.flaky.run", { mode: "fast" }, "failed", "invoke"),
    ],
    "ratchet",
  ),
  trace(
    [
      op("memory.expand", { session: "s1" }),
      ...["s2", "s3", "s4", "s5", "s6", "s7", "s8"].map((session) =>
        op("memory.expand", { session }),
      ),
    ],
    "ratchet",
  ),
];

const ratchetSurface = (): EntropySurfaceSnapshot =>
  surfaceOf([
    {
      ref: "mcp.report.render",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["format"],
        properties: { format: { type: "string" } },
      },
    },
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
      ref: "memory.expand",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["session"],
        properties: { session: { type: "string" } },
      },
    },
  ]);

const ratchetRepairs = () => [
  { kind: "keyAlias" as const, ref: "memory.expand", from: "sessionId", to: "session" },
];

const structureTraces = (): EntropyTraceInput[] => [
  trace(
    [
      op("pi.read", { path: "a" }),
      op("pi.grep", { path: "." }),
      op("pi.edit", { path: "a" }),
    ],
    "loop",
  ),
  trace(
    [
      op("pi.read", { path: "b" }),
      op("pi.grep", { path: "." }),
      op("pi.edit", { path: "b" }),
    ],
    "loop",
  ),
  trace(
    [
      op("mcp.store.put", { key: "k", value: "v" }),
      op("mcp.store.put", { key: "k", value: "v" }),
      op("mcp.store.put", { key: "k", value: "v" }),
      op("mcp.store.put", { prefix: "p", limit: 10 }),
      op("mcp.store.put", { prefix: "p", limit: 10 }),
      op("mcp.store.put", { prefix: "p", limit: 10 }),
    ],
    "structure",
  ),
];

const compiledRatchet = () => {
  const before = measureEntropy({
    traces: ratchetTraces(),
    surface: ratchetSurface(),
    repairs: ratchetRepairs(),
  });
  const proposals = proposeEntropyReductions({
    report: before,
    traces: ratchetTraces(),
    surface: ratchetSurface(),
    repairs: ratchetRepairs(),
  });
  const compiled = applyProposalsToSurface(ratchetSurface(), proposals);
  const retired = ratchetRepairs().filter(
    (row) =>
      !proposals.some(
        (proposal) =>
          proposal.kind === "modal-rename" &&
          proposal.level === "key" &&
          proposal.ref === row.ref &&
          proposal.from === row.from,
      ),
  );
  return { before, proposals, compiled, retired };
};

describe("proposeEntropyReductions", () => {
  it("proposes enum-tighten, modal-rename, and noise-quarantine for the ratchet corpus", () => {
    const { proposals } = compiledRatchet();
    expect(proposals).toHaveLength(3);
    expect(proposals.find((proposal) => proposal.kind === "enum-tighten")).toMatchObject({
      ref: "mcp.report.render",
      key: "format",
      values: ["pdf", "html"],
      calls: 8,
      distinct: 2,
      topShare: 0.875,
    });
    expect(
      proposals.find((proposal) => proposal.kind === "modal-rename"),
    ).toMatchObject({
      level: "key",
      ref: "memory.expand",
      from: "sessionId",
      to: "session",
    });
    expect(
      proposals.find((proposal) => proposal.kind === "noise-quarantine"),
    ).toMatchObject({
      ref: "mcp.flaky.run",
      calls: 4,
      succeeded: 0,
      failed: 4,
      failureStageEntropyBits: 1,
    });
  });

  it("converges: a compiled surface stops re-proposing", () => {
    const { compiled, retired } = compiledRatchet();
    const after = measureEntropy({
      traces: ratchetTraces(),
      surface: compiled,
      repairs: retired,
    });
    expect(
      proposeEntropyReductions({
        report: after,
        traces: ratchetTraces(),
        surface: compiled,
        repairs: retired,
      }),
    ).toEqual([]);
  });

  it("applies proposals without mutating the input surface", () => {
    const surface = ratchetSurface();
    const snapshot = JSON.stringify(surface);
    const before = measureEntropy({
      traces: ratchetTraces(),
      surface: ratchetSurface(),
      repairs: ratchetRepairs(),
    });
    const proposals = proposeEntropyReductions({
      report: before,
      traces: ratchetTraces(),
      surface: ratchetSurface(),
      repairs: ratchetRepairs(),
    });
    const compiled = applyProposalsToSurface(surface, proposals);
    expect(JSON.stringify(surface)).toBe(snapshot);
    expect(compiled.actions.map((action) => action.ref)).toEqual([
      "mcp.report.render",
      "memory.expand",
    ]);
    const render = compiled.actions.find((action) => action.ref === "mcp.report.render");
    expect(
      (render?.inputSchema as { properties: { format: { enum?: unknown } } }).properties
        .format.enum,
    ).toEqual(["pdf", "html"]);
    const expand = compiled.actions.find((action) => action.ref === "memory.expand");
    const expandSchema = expand?.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(expandSchema.properties.sessionId).toBeDefined();
    expect(expandSchema.properties.session).toBeUndefined();
    expect(expandSchema.required).toEqual(["sessionId"]);
  });

  it("proposes sequence-fuse and overload-split for structural corpora", () => {
    const report = measureEntropy({ traces: structureTraces() });
    const proposals = proposeEntropyReductions({
      report,
      traces: structureTraces(),
    });
    expect(proposals).toHaveLength(2);
    expect(proposals.find((proposal) => proposal.kind === "sequence-fuse")).toMatchObject({
      sequence: ["pi.read", "pi.grep", "pi.edit"],
      occurrences: 2,
    });
    expect(proposals.find((proposal) => proposal.kind === "overload-split")).toMatchObject({
      ref: "mcp.store.put",
      shapeEntropyBits: 1,
      clusters: [
        { keys: ["key", "value"], calls: 3 },
        { keys: ["limit", "prefix"], calls: 3 },
      ],
    });
  });

  it("does not quarantine healthy refs", () => {
    const traces: EntropyTraceInput[] = [
      trace([
        op("mcp.ok.run", { a: 1 }, "failed", "validate"),
        op("mcp.ok.run", { a: 1 }),
        op("mcp.ok.run", { a: 1 }),
      ]),
    ];
    const report = measureEntropy({ traces });
    expect(proposeEntropyReductions({ report, traces })).toEqual([]);
  });

  it("renames actions for action-level modal-rename", () => {
    const traces: EntropyTraceInput[] = [
      trace([op("memory.expand", { session: "s1" })]),
    ];
    const surface = surfaceOf([
      {
        ref: "memory.expand",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["session"],
          properties: { session: { type: "string" } },
        },
      },
    ]);
    const repairs = [
      { kind: "actionAlias" as const, ref: "memory.expand", from: "expandEntry", to: "expand" },
    ];
    const report = measureEntropy({ traces, surface, repairs });
    const proposals = proposeEntropyReductions({ report, traces, surface, repairs });
    expect(proposals).toHaveLength(1);
    const compiled = applyProposalsToSurface(surface, proposals);
    expect(compiled.actions.map((action) => action.ref)).toEqual(["memory.expandEntry"]);
  });
});

describe("evaluateGate", () => {
  it("passes a strict decrease and fails any increase", () => {
    const { before, compiled, retired } = compiledRatchet();
    const after = measureEntropy({
      traces: ratchetTraces(),
      surface: compiled,
      repairs: retired,
    });
    const gate = evaluateGate(before, after);
    expect(gate.passed).toBe(true);
    expect(gate.delta).toBe(-0.153646);
    const regress = evaluateGate(after, before);
    expect(regress.passed).toBe(false);
    expect(regress.reasons[0]).toContain("score increased");
  });

  it("fails when successful calls drop", () => {
    const full = measureEntropy({ traces: ratchetTraces(), surface: ratchetSurface() });
    const partial = measureEntropy({
      traces: [trace([op("pi.read", { path: "src/a.ts", limit: 50 })])],
    });
    const gate = evaluateGate(full, partial);
    expect(gate.passed).toBe(false);
    expect(gate.reasons.join(" ")).toContain("successful calls dropped");
  });
});
