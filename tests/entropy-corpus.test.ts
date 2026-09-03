import { describe, expect, it } from "vitest";
import {
  entropyRepairRows,
  entropyTraceFromFabricTrace,
  entropyTracesFromSessionJsonl,
  measureEntropy,
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
