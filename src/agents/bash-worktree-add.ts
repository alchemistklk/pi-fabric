import fs from "node:fs";
import path from "node:path";
import { addCloneFirstWorktree } from "./clone-first-worktree.js";
import { executeFile } from "./transports/process-utils.js";

const BARE_SAFE = /^[A-Za-z0-9_./:@%+=,-]+$/;

export interface ParsedGitWorktreeAdd {
  gitCwd?: string;
  branch?: { flag: "-b" | "-B"; name: string };
  detach: boolean;
  quiet: boolean;
  dest: string;
  startPoint?: string;
}

export const parseGitWorktreeAdd = (command: string): ParsedGitWorktreeAdd | undefined => {
  const trimmed = command.trim();
  if (!trimmed || /[|&;()\n]/.test(trimmed)) return undefined;
  const tokens = trimmed.split(/\s+/);
  if (tokens[0] !== "git") return undefined;
  if (tokens.some((token) => !BARE_SAFE.test(token))) return undefined;
  let index = 1;
  let gitCwd: string | undefined;
  if (tokens[index] === "-C") {
    gitCwd = tokens[index + 1];
    if (!gitCwd) return undefined;
    index += 2;
  }
  if (tokens[index] !== "worktree" || tokens[index + 1] !== "add") return undefined;
  index += 2;
  let branch: ParsedGitWorktreeAdd["branch"];
  let detach = false;
  let quiet = false;
  let flagsEnded = false;
  const positionals: string[] = [];
  while (index < tokens.length) {
    const token = tokens[index++];
    if (token === undefined) break;
    if (!flagsEnded && token === "--") {
      flagsEnded = true;
      continue;
    }
    if (!flagsEnded && (token === "-b" || token === "-B")) {
      if (branch) return undefined;
      const name = tokens[index++];
      if (!name) return undefined;
      branch = { flag: token, name };
      continue;
    }
    if (!flagsEnded && (token === "--detach" || token === "-d")) {
      detach = true;
      continue;
    }
    if (!flagsEnded && (token === "-q" || token === "--quiet")) {
      quiet = true;
      continue;
    }
    if (!flagsEnded && token.startsWith("-")) return undefined;
    positionals.push(token);
  }
  if (detach && branch) return undefined;
  if (positionals.length < 1 || positionals.length > 2) return undefined;
  return {
    ...(gitCwd ? { gitCwd } : {}),
    ...(branch ? { branch } : {}),
    detach,
    quiet,
    dest: positionals[0]!,
    ...(positionals[1] ? { startPoint: positionals[1] } : {}),
  };
};

export interface BashToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: { exitCode: number; cloned: boolean };
}

export const tryExecuteGitWorktreeAdd = async (
  args: Record<string, unknown>,
  sessionCwd: string,
): Promise<BashToolResult | undefined> => {
  const command = args.command;
  if (typeof command !== "string") return undefined;
  const parsed = parseGitWorktreeAdd(command);
  if (!parsed) return undefined;
  const gitCwd = parsed.gitCwd
    ? path.resolve(sessionCwd, parsed.gitCwd)
    : typeof args.cwd === "string"
      ? args.cwd
      : sessionCwd;
  const dest = path.resolve(gitCwd, parsed.dest);
  let gitRoot: string;
  try {
    const root = await executeFile("git", ["rev-parse", "--show-toplevel"], {
      cwd: gitCwd,
      timeoutMs: 10_000,
    });
    const output = root.stdout.trim();
    if (!output) return undefined;
    gitRoot = fs.realpathSync(output);
  } catch {
    return undefined;
  }
  const result = await addCloneFirstWorktree({
    gitRoot,
    dest,
    ...(parsed.branch ? { branch: parsed.branch } : {}),
    detach: parsed.detach,
    quiet: parsed.quiet,
    ...(parsed.startPoint ? { startPoint: parsed.startPoint } : {}),
  });
  return {
    content: [{ type: "text", text: result.message || `Preparing worktree (${dest})` }],
    details: { exitCode: 0, cloned: result.cloned },
  };
};
