import { describe, expect, it } from "vitest";
import {
  fabricScriptPayload,
  prepareFabricExecArguments,
} from "../src/fabric-exec-arguments.js";

describe("prepareFabricExecArguments", () => {
  it("keeps canonical arguments unchanged", () => {
    const input = { code: "return 1;", tokenBudget: 10 };
    expect(prepareFabricExecArguments(input)).toBe(input);
  });

  it("wraps a root code string before schema validation", () => {
    expect(prepareFabricExecArguments("return 1;")).toEqual({ code: "return 1;" });
  });

  it("joins all-string code arrays and leaves malformed arrays invalid", () => {
    expect(prepareFabricExecArguments({ code: ["const x = 1;", "return x;"] })).toEqual({
      code: "const x = 1;\nreturn x;",
    });
    const malformed = { code: ["return ", 1] };
    expect(prepareFabricExecArguments(malformed)).toBe(malformed);
  });

  it("omits null optional fields but preserves a null required code", () => {
    expect(prepareFabricExecArguments({
      code: null,
      strings: null,
      resultFormat: null,
      tokenBudget: null,
      agentBudget: undefined,
      display: null,
    })).toEqual({ code: null });
  });

  it("canonicalizes display shorthands before execution", () => {
    expect(prepareFabricExecArguments({ code: "return 1;", display: "Probe" })).toEqual({
      code: "return 1;",
      display: { name: "Probe" },
    });
    expect(prepareFabricExecArguments({
      code: "return 1;",
      display: '{"name":"Probe","description":"check"}',
    })).toEqual({
      code: "return 1;",
      display: { name: "Probe", description: "check" },
    });
  });
});

describe("prepareFabricExecArguments script mode", () => {
  const scriptOf = (args: unknown): unknown =>
    (prepareFabricExecArguments(args) as { strings?: Record<string, string> }).strings;

  it("compiles a bare script onto the code + strings path", () => {
    expect(prepareFabricExecArguments({ script: "set -eu\nprintf 'done\\n'" })).toEqual({
      code: "const result = await pi.bash(π.__fabric_script); return result.output;",
      strings: { __fabric_script: "set -eu\nprintf 'done\\n'" },
    });
  });

  it("preserves the payload byte-for-byte", () => {
    const payload = "grep -oE '\\$\\{HOME\\}' <<'EOF'\n`x` \"y\" 'z' \\\\n\nEOF";
    expect(scriptOf({ script: payload })).toEqual({ __fabric_script: payload });
  });

  it("compiles execution options into the nested option object", () => {
    expect(prepareFabricExecArguments({ script: "ls", timeout: 600 })).toEqual({
      code: "const result = await pi.bash(π.__fabric_script, { timeout: 600 }); return result.output;",
      strings: { __fabric_script: "ls" },
    });
    expect(prepareFabricExecArguments({ script: "ls", settle: true })).toEqual({
      code:
        "const result = await pi.bash(π.__fabric_script, { settle: true }); "
        + "return result.ok ? { ok: true, exitCode: 0, output: result.output } : "
        + "{ ok: false, exitCode: result.exitCode, output: result.output };",
      strings: { __fabric_script: "ls" },
    });
    expect(prepareFabricExecArguments({ script: "ls", timeout: 600, settle: true })).toEqual({
      code:
        "const result = await pi.bash(π.__fabric_script, { timeout: 600, settle: true }); "
        + "return result.ok ? { ok: true, exitCode: 0, output: result.output } : "
        + "{ ok: false, exitCode: result.exitCode, output: result.output };",
      strings: { __fabric_script: "ls" },
    });
  });

  it("keeps display and resultFormat on the outer call", () => {
    expect(prepareFabricExecArguments({
      script: "ls",
      resultFormat: "json",
      display: "List",
    })).toEqual({
      code: "const result = await pi.bash(π.__fabric_script); return result.output;",
      strings: { __fabric_script: "ls" },
      resultFormat: "json",
      display: { name: "List" },
    });
  });

  it("is idempotent over an already compiled call", () => {
    const once = prepareFabricExecArguments({ script: "ls", timeout: 30, settle: true });
    expect(prepareFabricExecArguments(once)).toEqual(once);
    const plain = prepareFabricExecArguments({ script: "ls" });
    expect(prepareFabricExecArguments(plain)).toEqual(plain);
  });

  it("rejects code and script together", () => {
    expect(() => prepareFabricExecArguments({ code: "return 1;", script: "ls" }))
      .toThrow(/`code` or `script`, not both/);
  });

  it("rejects an argument object with no program", () => {
    expect(() => prepareFabricExecArguments({})).toThrow(/either `code`.*or.*`script`/s);
    expect(() => prepareFabricExecArguments({ display: "Probe" }))
      .toThrow(/either `code`.*or.*`script`/s);
  });

  it("rejects a non-string script", () => {
    expect(() => prepareFabricExecArguments({ script: 12 })).toThrow(/`script` must be a string/);
    expect(() => prepareFabricExecArguments({ script: ["ls"] }))
      .toThrow(/`script` must be a string/);
  });

  it("rejects keys a shell payload cannot reach", () => {
    expect(() => prepareFabricExecArguments({ script: "ls", strings: { a: "b" } }))
      .toThrow(/`strings` cannot be used with `script`/);
    expect(() => prepareFabricExecArguments({ script: "ls", tokenBudget: 10 }))
      .toThrow(/`tokenBudget` cannot be used with `script`/);
    expect(() => prepareFabricExecArguments({ script: "ls", agentBudget: 2 }))
      .toThrow(/`agentBudget` cannot be used with `script`/);
  });

  it("rejects script options without a script", () => {
    expect(() => prepareFabricExecArguments({ code: "return 1;", timeout: 60 }))
      .toThrow(/`timeout` is a script-mode option and requires `script`/);
    expect(() => prepareFabricExecArguments({ code: "return 1;", settle: true }))
      .toThrow(/`settle` is a script-mode option and requires `script`/);
  });

  it("rejects malformed script option values", () => {
    expect(() => prepareFabricExecArguments({ script: "ls", timeout: 0 }))
      .toThrow(/whole number of seconds between 1 and 86400/);
    expect(() => prepareFabricExecArguments({ script: "ls", timeout: 1.5 }))
      .toThrow(/whole number of seconds between 1 and 86400/);
    expect(() => prepareFabricExecArguments({ script: "ls", timeout: "600" }))
      .toThrow(/whole number of seconds between 1 and 86400/);
    expect(() => prepareFabricExecArguments({ script: "ls", settle: "true" }))
      .toThrow(/`settle` must be a boolean/);
  });

  it("rejects a caller-provided collision on the reserved key", () => {
    expect(() => prepareFabricExecArguments({
      code: "return π.__fabric_script;",
      strings: { __fabric_script: "ls" },
    })).toThrow(/reserves `strings.__fabric_script`/);
  });

  it("treats null script options as absent", () => {
    expect(prepareFabricExecArguments({ code: "return 1;", timeout: null, settle: null }))
      .toEqual({ code: "return 1;", timeout: null, settle: null });
  });
});

describe("fabricScriptPayload", () => {
  it("resolves the payload only for a genuinely compiled program", () => {
    const compiled = prepareFabricExecArguments({ script: "ls -la" });
    expect(fabricScriptPayload(compiled)).toBe("ls -la");
    expect(fabricScriptPayload({ code: "return 1;" })).toBeNull();
    expect(fabricScriptPayload({
      code: "return 1;",
      strings: { __fabric_script: "ls" },
    })).toBeNull();
    expect(fabricScriptPayload({
      code: "const result = await pi.bash(π.__fabric_script); return result.output; drop();",
      strings: { __fabric_script: "ls" },
    })).toBeNull();
  });
});
