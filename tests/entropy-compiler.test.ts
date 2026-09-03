import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compileEntropySurface,
  loadCompiledSurface,
  saveCompiledSurface,
  schemaDigest,
  type CompiledSurfaceFile,
  type EntropyOperationInput,
  type EntropySurfaceSnapshot,
  type EntropyTraceInput,
} from "../src/entropy/index.js";

const tmpRoots: string[] = [];
const makeTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-entropy-compiler-"));
  tmpRoots.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of tmpRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const op = (
  ref: string,
  args: Record<string, unknown>,
  outcome: "succeeded" | "failed" = "succeeded",
  failureStage?: string,
): EntropyOperationInput => ({ ref, args, outcome, ...(failureStage ? { failureStage } : {}) });

const trace = (operations: EntropyOperationInput[], taskKey?: string): EntropyTraceInput => ({
  operations,
  ...(taskKey ? { taskKey } : {}),
});

const ratchetSurface = (): EntropySurfaceSnapshot => ({
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
      ref: "mcp.report.render",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["format"],
        properties: { format: { type: "string", enum: ["docx", "html", "pdf", "web"] } },
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
  ],
});

const renderLiveSchema = () =>
  ratchetSurface().actions.find((action) => action.ref === "mcp.report.render")!.inputSchema;
const flakyLiveSchema = () =>
  ratchetSurface().actions.find((action) => action.ref === "mcp.flaky.run")!.inputSchema;

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

const ratchetRepairs = () => [
  { kind: "keyAlias" as const, ref: "memory.expand", from: "sessionId", to: "session" },
];

const compileInput = () => ({
  traces: ratchetTraces(),
  surface: ratchetSurface(),
  repairs: ratchetRepairs(),
});

describe("compileEntropySurface", () => {
  it("applies the mechanical subset through the gate and builds the artifact", () => {
    const outcome = compileEntropySurface(compileInput());
    expect(outcome.status).toBe("compiled");
    expect(outcome.report.score).toBe(0.323019);
    expect(outcome.gate?.passed).toBe(true);
    expect(outcome.after!.score).toBe(0.304789);
    expect(outcome.gate!.delta).toBe(-0.01823);
    const artifact = outcome.artifact!;
    expect(artifact.actions).toHaveLength(1);
    expect(artifact.actions[0]!.ref).toBe("mcp.report.render");
    expect(artifact.actions[0]!.baseSchemaDigest).toBe(schemaDigest(renderLiveSchema()));
    const properties = artifact.actions[0]!.inputSchema.properties as Record<
      string,
      { enum?: unknown[] }
    >;
    expect(properties.format?.enum).toEqual(["pdf", "html"]);
    expect(artifact.quarantined).toEqual([
      { ref: "mcp.flaky.run", baseSchemaDigest: schemaDigest(flakyLiveSchema()) },
    ]);
    expect(artifact.applied.map((entry) => entry.kind)).toEqual([
      "enum-tighten",
      "noise-quarantine",
    ]);
    expect(artifact.gate.passed).toBe(true);
  });

  it("converges on the compiled artifact and leaves review-only proposals surfaced", () => {
    const first = compileEntropySurface(compileInput());
    const second = compileEntropySurface({
      ...compileInput(),
      ...(first.artifact ? { artifact: first.artifact } : {}),
    });
    expect(second.status).toBe("converged");
    expect(second.artifact).toBe(first.artifact);
    expect(second.proposals.map((proposal) => proposal.kind)).toEqual(["modal-rename"]);
  });

  it("rejects a compile whose enum would break a recorded successful call", () => {
    const divergent = compileEntropySurface({
      traces: [
        trace([
          ...Array.from({ length: 8 }, () => op("mcp.report.render", { format: "pdf" })),
          op("mcp.report.render", { format: "web" }),
        ]),
      ],
      surface: ratchetSurface(),
      valueObservations: [
        ...Array.from({ length: 8 }, () => ({
          ref: "mcp.report.render",
          key: "format",
          value: "pdf",
        })),
        { ref: "mcp.report.render", key: "format", value: "html" },
        { ref: "mcp.report.render", key: "format", value: "html" },
      ],
    });
    expect(divergent.status).toBe("rejected");
    expect(divergent.gate?.passed).toBe(false);
    expect(divergent.gate?.reasons).toEqual([
      "mcp.report.render: recorded arguments no longer validate against the compiled schema",
    ]);
    expect(divergent.artifact).toBeUndefined();
  });

  it("treats a gate-proven enum as a floor and converges on pre-birth evidence", () => {
    const declared = {
      type: "object",
      properties: { format: { type: "string" } },
      required: ["format"],
      additionalProperties: false,
    };
    const surface: EntropySurfaceSnapshot = {
      version: 1,
      actions: [{ ref: "mcp.render", inputSchema: declared }],
    };
    const incumbent: CompiledSurfaceFile = {
      version: 1,
      metricVersion: 2,
      actions: [
        {
          ref: "mcp.render",
          inputSchema: {
            ...declared,
            properties: { format: { type: "string", enum: ["pdf", "html"] } },
          },
          baseSchemaDigest: schemaDigest(declared),
        },
      ],
      quarantined: [],
      applied: [{ kind: "enum-tighten", ref: "mcp.render", detail: "format: 2 observed values" }],
      gate: { passed: true, beforeScore: 0.02, afterScore: 0.01, reasons: [] },
      evidenceDigest: "birth",
    };
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
    const outcome = compileEntropySurface({
      traces,
      surface,
      artifact: incumbent,
      valueObservations,
    });
    expect(outcome.status).toBe("converged");
    expect(outcome.artifact).toBe(incumbent);
    expect(outcome.gate).toBeUndefined();
  });

  it("replays verbatim audits so projected traces cannot poison the gate", () => {
    const declared = {
      type: "object",
      properties: { format: { type: "string", enum: ["docx", "html", "pdf"] } },
      required: ["format"],
      additionalProperties: false,
    };
    const surface: EntropySurfaceSnapshot = {
      version: 1,
      actions: [{ ref: "mcp.render", inputSchema: declared }],
    };
    const traces = [trace(Array.from({ length: 8 }, () => op("mcp.render", {})))];
    const valueObservations = [
      ...Array.from({ length: 6 }, () => ({ ref: "mcp.render", key: "format", value: "pdf" })),
      { ref: "mcp.render", key: "format", value: "html" },
      { ref: "mcp.render", key: "format", value: "html" },
    ];
    const auditCalls = [
      ...Array.from({ length: 6 }, () => ({ ref: "mcp.render", args: { format: "pdf" } })),
      { ref: "mcp.render", args: { format: "html" } },
      { ref: "mcp.render", args: { format: "html" } },
    ];
    const outcome = compileEntropySurface({ traces, surface, valueObservations, auditCalls });
    expect(outcome.status).toBe("compiled");
    expect(outcome.gate?.passed).toBe(true);
    const poisoned = compileEntropySurface({ traces, surface, valueObservations });
    expect(poisoned.status).toBe("rejected");
    expect(poisoned.gate?.reasons).toHaveLength(8);
    expect(poisoned.gate?.reasons[0]).toBe(
      "mcp.render: recorded arguments no longer validate against the compiled schema",
    );
  });
});

describe("compiled surface store", () => {
  it("round-trips the artifact, no-ops identical writes, and surfaces damage", () => {
    const agentDir = makeTempDir();
    expect(loadCompiledSurface(agentDir)).toEqual({});
    const outcome = compileEntropySurface(compileInput());
    const artifact = outcome.artifact!;
    const saved = saveCompiledSurface(agentDir, artifact);
    expect(saved.written).toBe(true);
    const loaded = loadCompiledSurface(agentDir);
    expect(loaded.error).toBeUndefined();
    expect(loaded.file).toEqual(artifact);
    expect(saveCompiledSurface(agentDir, artifact).written).toBe(false);
    const file = path.join(agentDir, "fabric", "entropy", "compiled.json");
    fs.writeFileSync(file, "{ nope");
    const damaged = loadCompiledSurface(agentDir);
    expect(damaged.error).toBe("compiled surface is malformed JSON");
    // Damage blocks the overwrite instead of silently rebuilding.
    expect(() => saveCompiledSurface(agentDir, artifact)).toThrow(
      "compiled surface is malformed JSON",
    );
  });
});