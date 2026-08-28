import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { ActionRegistry, type FabricCallAudit } from "../src/core/action-registry.js";
import { FabricExecutionService } from "../src/execution-service.js";
import { PiToolsProvider } from "../src/providers/pi-tools-provider.js";
import { prepareFabricExecArguments } from "../src/fabric-exec-arguments.js";

const compile = (args: Record<string, unknown>) =>
  prepareFabricExecArguments(args) as { code: string; strings: Record<string, string> };

const runScript = async (
  cwd: string,
  args: Record<string, unknown>,
): Promise<{
  success: boolean;
  value: unknown;
  audits: FabricCallAudit[];
  error?: string;
}> => {
  const registry = new ActionRegistry();
  registry.register(new PiToolsProvider(cwd, undefined, undefined));
  const config = structuredClone(DEFAULT_FABRIC_CONFIG);
  config.approvals.execute = "allow";
  const service = new FabricExecutionService(registry, config);
  const { code, strings } = compile(args);
  const result = await service.execute({
    code,
    strings,
    signal: undefined,
    parentToolCallId: "script-probe",
    context: {
      cwd,
      hasUI: false,
      sessionManager: {
        getSessionId: () => "script-probe-session",
        getSessionFile: () => undefined,
      },
    } as unknown as ExtensionContext,
    onPartial() {},
  });
  return {
    success: result.success,
    value: result.value,
    audits: result.audits,
    ...(result.error ? { error: result.error } : {}),
  };
};

const withTempDir = async (run: (cwd: string) => Promise<void>): Promise<void> => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-script-"));
  try {
    await run(cwd);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
};

describe("script mode end to end", () => {
  // The whole point of the feature: this payload is what triple escaping
  // through JSON → a TypeScript string literal → shell gets wrong. It travels
  // as a plain string in `strings` and is never re-quoted by Fabric.
  it("runs shell metacharacters that would not survive a TypeScript literal", async () => {
    await withTempDir(async (cwd) => {
      const script = [
        "set -eu",
        "cat > sample.txt <<'EOF'",
        "alpha `backtick` ${NOT_EXPANDED} \"double\" 'single' \\backslash",
        "beta 2026-08-28",
        "EOF",
        "sed -E 's/([0-9]{4})-([0-9]{2})-([0-9]{2})/\\3\\/\\2\\/\\1/' sample.txt | tail -1",
        "printf '%s\\n' \"home=$(basename \"${HOME}\")\" >/dev/null",
      ].join("\n");

      const result = await runScript(cwd, { script });

      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
      expect(result.value).toBe("beta 28/08/2026\n");
      // The payload reaches pi.bash byte-for-byte as the command.
      expect(result.audits).toHaveLength(1);
      expect(result.audits[0]?.ref).toBe("pi.bash");
      expect(result.audits[0]?.args).toEqual({ command: script });
      // Written by the heredoc, so the literal text survived unexpanded.
      expect(fs.readFileSync(path.join(cwd, "sample.txt"), "utf8"))
        .toContain("`backtick` ${NOT_EXPANDED}");
    });
  });

  it("fails a nonzero exit without settle, the way any nested pi.bash does", async () => {
    await withTempDir(async (cwd) => {
      const result = await runScript(cwd, { script: "printf 'partial\\n'\nexit 7" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Command exited with code 7");
    });
  });

  it("returns the exit code alongside the output under settle", async () => {
    await withTempDir(async (cwd) => {
      const result = await runScript(cwd, {
        script: "printf 'partial\\n'\nexit 7",
        settle: true,
      });
      expect(result.success).toBe(true);
      // Not just the text: discarding exitCode here would defeat the option.
      expect(result.value).toMatchObject({ ok: false, exitCode: 7 });
      expect((result.value as { output: string }).output).toContain("partial");
    });
  });

  it("keeps the plain envelope for a successful settle run", async () => {
    await withTempDir(async (cwd) => {
      const result = await runScript(cwd, { script: "printf 'ok\\n'", settle: true });
      expect(result.value).toEqual({ ok: true, exitCode: 0, output: "ok\n" });
    });
  });

  it("passes timeout to the host in seconds", async () => {
    await withTempDir(async (cwd) => {
      // 2 seconds, not 2 milliseconds: a millisecond unit would abort this.
      const result = await runScript(cwd, {
        script: "sleep 0.3\nprintf 'slept\\n'",
        timeout: 2,
      });
      expect(result.success).toBe(true);
      expect(result.value).toBe("slept\n");
    });
  });
});
