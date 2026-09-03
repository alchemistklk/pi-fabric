import { describe, expect, it } from "vitest";
import {
  classifyInvalidArgs,
  classifyToolResult,
  classifyTypeErrors,
  classifyUnknownAction,
} from "../src/repairs/classify.js";

describe("classifyToolResult", () => {
  it("drops bash and edit-miss as effect", () => {
    expect(
      classifyToolResult({
        toolName: "bash",
        isError: true,
        content: [{ type: "text", text: "exit 1" }],
      }),
    ).toMatchObject({ stage: "effect", fingerprint: "effect:bash" });
    expect(
      classifyToolResult({
        toolName: "edit",
        isError: true,
        content: "Could not find the exact text in src/a.ts",
      })?.stage,
    ).toBe("effect");
  });

  it("classifies fabric_exec outer schema and typecheck", () => {
    expect(
      classifyToolResult({
        toolName: "fabric_exec",
        isError: true,
        content: {
          content: [{
            type: "text",
            text: 'Validation failed for tool "fabric_exec":\n  - display: must be object',
          }],
          isError: true,
        },
      }),
    ).toMatchObject({ stage: "invocation_outer_schema", fingerprint: "outer:display:object" });
    expect(
      classifyToolResult({
        toolName: "fabric_exec",
        isError: true,
        content: "Type errors; code was not executed:\nLine 1:1 — Cannot find name 'echo'",
      })?.stage,
    ).toBe("didactic");
  });
});

describe("classifyTypeErrors", () => {
  it("marks shell tokens didactic and arity as typecheck", () => {
    expect(classifyTypeErrors(["Cannot find name 'echo'"])[0]?.stage).toBe("didactic");
    expect(classifyTypeErrors(["Expected 1 arguments, but got 2"], "read")[0]).toMatchObject({
      stage: "invocation_typecheck",
      fingerprint: "typecheck:arity:1<-2:read",
    });
  });
});

describe("classifyInvalidArgs", () => {
  it("fingerprints extra keys", () => {
    expect(
      classifyInvalidArgs("memory.expand", "/sessionId: must not have additional properties"),
    ).toMatchObject({
      stage: "invocation_args",
      fingerprint: "args:memory.expand:sessionId",
    });
  });
});

describe("classifyUnknownAction", () => {
  it("keeps provider.action", () => {
    expect(classifyUnknownAction("memory.search")).toEqual({
      stage: "invocation_unknown_action",
      fingerprint: "unknown:memory.search",
    });
  });
});

