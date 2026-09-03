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
        properties: { format: { type: "string", enum: ["docx", "html", "pdf", "web"] } },
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

  it("keeps a gate-proven enum as a floor: pre-birth observations never widen", () => {
    const incumbent = surfaceOf([
      {
        ref: "mcp.render",
        inputSchema: {
          type: "object",
          properties: { format: { type: "string", enum: ["pdf", "html"] } },
          required: ["format"],
          additionalProperties: false,
        },
      },
    ]);
    const traces = [
      trace([
        ...Array.from({ length: 5 }, () => op("mcp.render", { format: "pdf" })),
        op("mcp.render", { format: "html" }),
        op("mcp.render", { format: "html" }),
        op("mcp.render", { format: "docx" }),
      ]),
    ];
    const valueObservations = [
      ...Array.from({ length: 5 }, () => ({ ref: "mcp.render", key: "format", value: "pdf" })),
      { ref: "mcp.render", key: "format", value: "html" },
      { ref: "mcp.render", key: "format", value: "html" },
      { ref: "mcp.render", key: "format", value: "docx" },
    ];
    const report = measureEntropy({ traces, surface: incumbent });
    expect(
      proposeEntropyReductions({ report, traces, surface: incumbent, valueObservations }),
    ).toEqual([]);
  });

  it("still tightens beneath a floor when incumbent values age out", () => {
    const incumbent = surfaceOf([
      {
        ref: "mcp.render",
        inputSchema: {
          type: "object",
          properties: { format: { type: "string", enum: ["pdf", "html", "docx"] } },
          required: ["format"],
          additionalProperties: false,
        },
      },
    ]);
    const traces = [
      trace([
        ...Array.from({ length: 6 }, () => op("mcp.render", { format: "pdf" })),
        op("mcp.render", { format: "html" }),
        op("mcp.render", { format: "html" }),
      ]),
    ];
    const valueObservations = [
      ...Array.from({ length: 6 }, () => ({ ref: "mcp.render", key: "format", value: "pdf" })),
      { ref: "mcp.render", key: "format", value: "html" },
      { ref: "mcp.render", key: "format", value: "html" },
    ];
    const report = measureEntropy({ traces, surface: incumbent });
    expect(
      proposeEntropyReductions({ report, traces, surface: incumbent, valueObservations }),
    ).toEqual([
      expect.objectContaining({
        kind: "enum-tighten",
        ref: "mcp.render",
        key: "format",
        values: ["pdf", "html"],
      }),
    ]);
  });

  it("never proposes enum-tighten for a declared boolean parameter", () => {
    const surface = surfaceOf([
      {
        ref: "mcp.flags.set",
        inputSchema: {
          type: "object",
          properties: { force: { type: "boolean" } },
          required: ["force"],
          additionalProperties: false,
        },
      },
    ]);
    const traces = [
      trace([
        ...Array.from({ length: 5 }, () => op("mcp.flags.set", { force: true })),
        ...Array.from({ length: 3 }, () => op("mcp.flags.set", { force: false })),
      ]),
    ];
    const valueObservations = [
      ...Array.from({ length: 5 }, () => ({ ref: "mcp.flags.set", key: "force", value: true })),
      ...Array.from({ length: 3 }, () => ({ ref: "mcp.flags.set", key: "force", value: false })),
    ];
    expect(
      proposeEntropyReductions({
        report: measureEntropy({ traces, surface }),
        traces,
        surface,
        valueObservations,
      }),
    ).toEqual([]);
    expect(
      proposeEntropyReductions({
        report: measureEntropy({ traces }),
        traces,
        valueObservations,
      }),
    ).toEqual([expect.objectContaining({ kind: "declare-enum" })]);
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

  it("routes open-domain vocabularies to declare-enum review, never auto", () => {
    const surface = surfaceOf([
      {
        ref: "mcp.report.render",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["format"],
          properties: { format: { type: "string" } },
        },
      },
    ]);
    const traces: EntropyTraceInput[] = [
      trace([
        ...Array.from({ length: 7 }, () => op("mcp.report.render", { format: "pdf" })),
        op("mcp.report.render", { format: "html" }),
      ]),
    ];
    const proposals = proposeEntropyReductions({
      report: measureEntropy({ traces, surface }),
      traces,
      surface,
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      kind: "declare-enum",
      ref: "mcp.report.render",
      key: "format",
      values: ["pdf", "html"],
      calls: 8,
      distinct: 2,
      topShare: 0.875,
    });
  });

  it("signals undeclared keys and unknown refs through declare-enum", () => {
    const surface = surfaceOf([
      {
        ref: "mcp.report.render",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["format"],
          properties: { format: { type: "string", enum: ["docx", "html", "pdf"] } },
        },
      },
    ]);
    const traces: EntropyTraceInput[] = [
      trace([
        ...Array.from({ length: 4 }, () => op("mcp.report.render", { format: "pdf", dpi: 300 })),
        ...Array.from({ length: 4 }, () => op("mcp.report.render", { format: "pdf", dpi: 600 })),
      ]),
      trace([
        ...Array.from({ length: 6 }, () => op("mcp.ghost.run", { level: "info" })),
        ...Array.from({ length: 2 }, () => op("mcp.ghost.run", { level: "debug" })),
      ]),
    ];
    const proposals = proposeEntropyReductions({
      report: measureEntropy({ traces, surface }),
      traces,
      surface,
    });
    expect(proposals).toHaveLength(2);
    expect(proposals[0]).toMatchObject({
      kind: "declare-enum",
      ref: "mcp.ghost.run",
      key: "level",
      values: ["info", "debug"],
      calls: 8,
      distinct: 2,
      topShare: 0.75,
    });
    expect(proposals[1]).toMatchObject({
      kind: "declare-enum",
      ref: "mcp.report.render",
      key: "dpi",
      values: [300, 600],
      calls: 8,
      distinct: 2,
      topShare: 0.5,
    });
  });

  it("converges when the observed vocabulary equals the declared enum", () => {
    const surface = surfaceOf([
      {
        ref: "mcp.report.render",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["format"],
          properties: { format: { type: "string", enum: ["html", "pdf"] } },
        },
      },
    ]);
    const traces: EntropyTraceInput[] = [
      trace([
        ...Array.from({ length: 7 }, () => op("mcp.report.render", { format: "pdf" })),
        op("mcp.report.render", { format: "html" }),
      ]),
    ];
    expect(
      proposeEntropyReductions({
        report: measureEntropy({ traces, surface }),
        traces,
        surface,
      }),
    ).toEqual([]);
  });

  it("drops observations outside the declared domain and tightens to the remainder", () => {
    const surface = surfaceOf([
      {
        ref: "mcp.report.render",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["format"],
          properties: { format: { type: "string", enum: ["html", "pdf", "web"] } },
        },
      },
    ]);
    const traces: EntropyTraceInput[] = [
      trace([
        ...Array.from({ length: 6 }, () => op("mcp.report.render", { format: "pdf" })),
        op("mcp.report.render", { format: "html" }),
        op("mcp.report.render", { format: "rtf" }),
      ]),
    ];
    const proposals = proposeEntropyReductions({
      report: measureEntropy({ traces, surface }),
      traces,
      surface,
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      kind: "enum-tighten",
      ref: "mcp.report.render",
      key: "format",
      values: ["pdf", "html"],
      distinct: 2,
    });
  });

  it("weights pooled observations by count multiplicity", () => {
    const surface = surfaceOf([
      {
        ref: "mcp.report.render",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["format"],
          properties: { format: { type: "string", enum: ["docx", "html", "pdf"] } },
        },
      },
    ]);
    const traces: EntropyTraceInput[] = [trace([op("mcp.report.render", { format: "pdf" })])];
    const valueObservations = [
      { ref: "mcp.report.render", key: "format", value: "pdf", count: 7 },
      { ref: "mcp.report.render", key: "format", value: "html", count: 1 },
    ];
    const proposals = proposeEntropyReductions({
      report: measureEntropy({ traces, surface }),
      traces,
      surface,
      valueObservations,
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      kind: "enum-tighten",
      values: ["pdf", "html"],
      calls: 8,
      distinct: 2,
      topShare: 0.875,
    });
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
    expect(gate.delta).toBe(-0.14323);
    expect(before.staticScore).toBe(0.036458);
    expect(before.behavioralScore).toBe(0.286561);
    expect(after.staticScore).toBe(0.018229);
    expect(after.behavioralScore).toBe(0.16156);
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
