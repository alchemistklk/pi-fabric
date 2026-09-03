import { describe, expect, it } from "vitest";
import {
  entropyRepairRows,
  entropyTraceFromFabricTrace,
  entropyTracesFromSessionJsonl,
  entropyValueObservationsFromSessionJsonl,
  measureEntropy,
  proposeEntropyReductions,
} from "../src/entropy/index.js";
import type { FabricExecutionTraceV1 } from "../src/audit/trace.js";
import type { CatalogRepair } from "../src/repairs/types.js";

const fabricTrace = (phases: string[]): FabricExecutionTraceV1 => ({
  kind: "pi-fabric.execution",
  version: 1,
  outcome: "succeeded",
  phases,
  operations: [
    {
      type: "call",
      sequence: 0,
      ref: "pi.read",
      args: { path: "src/a.ts", limit: 10 },
      outcome: "succeeded",
    },
    {
      type: "call",
      sequence: 1,
      ref: "pi.bash",
      args: { command: "ls" },
      outcome: "failed",
      failureStage: "invoke",
      error: "boom",
    },
  ],
  counts: { droppedValues: 0, truncatedValues: 0, redactedValues: 0, droppedOperations: 0 },
});

describe("entropyTraceFromFabricTrace", () => {
  it("maps operations and derives the task key from the first phase", () => {
    const mapped = entropyTraceFromFabricTrace(fabricTrace(["build"]));
    expect(mapped.taskKey).toBe("build");
    expect(mapped.operations).toHaveLength(2);
    expect(mapped.operations[1]).toMatchObject({
      ref: "pi.bash",
      outcome: "failed",
      failureStage: "invoke",
    });
  });

  it("falls back to the default task key without phases", () => {
    expect(entropyTraceFromFabricTrace(fabricTrace([])).taskKey).toBe("(none)");
  });
});

describe("entropyTracesFromSessionJsonl", () => {
  it("skips malformed and non-trace lines and ingests guarded envelopes", () => {
    const envelope = fabricTrace(["build"]);
    const lines = [
      "{ not json",
      JSON.stringify({
        id: "e0",
        type: "message",
        message: { role: "user", content: "hi" },
      }),
      JSON.stringify({
        id: "e1",
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "fabric_exec",
          content: [{ type: "text", text: "ok" }],
          details: { success: true, trace: envelope, audits: [], phases: ["build"] },
        },
      }),
      "",
    ]
      .join("\n")
      .split("\n");
    const traces = entropyTracesFromSessionJsonl(lines);
    expect(traces).toHaveLength(1);
    const report = measureEntropy({ traces });
    expect(report.totals.operations).toBe(2);
    expect(report.totals.succeeded).toBe(1);
    expect(report.totals.failed).toBe(1);
  });
});

describe("entropyRepairRows", () => {
  it("normalizes key and action aliases to their target refs", () => {
    const repairs: CatalogRepair[] = [
      { kind: "keyAlias", ref: "memory.expand", from: "sessionId", to: "session" },
      { kind: "actionAlias", provider: "memory", from: "expandEntry", to: "expand" },
    ];
    expect(entropyRepairRows(repairs)).toEqual([
      { kind: "keyAlias", ref: "memory.expand", from: "sessionId", to: "session" },
      { kind: "actionAlias", ref: "memory.expand", from: "expandEntry", to: "expand" },
    ]);
  });
});

describe("entropyValueObservationsFromSessionJsonl", () => {
  it("extracts verbatim audit values for value-dropped params and drives enum-tighten", () => {
    const formats = ["pdf", "pdf", "pdf", "pdf", "pdf", "pdf", "pdf", "html"];
    const envelope: FabricExecutionTraceV1 = {
      kind: "pi-fabric.execution",
      version: 1,
      outcome: "succeeded",
      phases: ["build"],
      operations: formats.map((_, index) => ({
        type: "call" as const,
        sequence: index,
        ref: "mcp.report.render",
        args: {},
        outcome: "succeeded" as const,
      })),
      counts: { droppedValues: 0, truncatedValues: 0, redactedValues: 0, droppedOperations: 0 },
    };
    const audits = formats.map((format) => ({
      ref: "mcp.report.render",
      args: { format },
    }));
    const lines = JSON.stringify({
      id: "e1",
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "fabric_exec",
        content: [{ type: "text", text: "ok" }],
        details: { success: true, trace: envelope, audits, phases: ["build"] },
      },
    }).split("\n");
    const traces = entropyTracesFromSessionJsonl(lines);
    const observations = entropyValueObservationsFromSessionJsonl(lines);
    expect(observations).toHaveLength(8);
    expect(observations[0]).toEqual({
      ref: "mcp.report.render",
      key: "format",
      value: "pdf",
    });
    const report = measureEntropy({ traces });
    expect(proposeEntropyReductions({ report, traces })).toEqual([]);
    const proposals = proposeEntropyReductions({
      report,
      traces,
      valueObservations: observations,
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      kind: "enum-tighten",
      ref: "mcp.report.render",
      key: "format",
      values: ["pdf", "html"],
      calls: 8,
      distinct: 2,
      topShare: 0.875,
    });
  });
});
