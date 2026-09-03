import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  measureSessionCorpus,
  projectSessionFiles,
  trendFromScores,
  type EntropySurfaceSnapshot,
} from "../src/entropy/index.js";
import { encodeCwdDir } from "../src/memory/discovery.js";

const tmpRoots: string[] = [];
const makeTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-entropy-sessions-"));
  tmpRoots.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of tmpRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const sessionLine = () =>
  JSON.stringify({
    id: "e1",
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "fabric_exec",
      content: [{ type: "text", text: "ok" }],
      details: {
        success: true,
        trace: {
          kind: "pi-fabric.execution",
          version: 1,
          outcome: "succeeded",
          phases: ["build"],
          operations: [
            {
              type: "call",
              sequence: 0,
              ref: "pi.read",
              args: { path: "src/a.ts", limit: 10 },
              outcome: "succeeded",
            },
          ],
          counts: {
            droppedValues: 0,
            truncatedValues: 0,
            redactedValues: 0,
            droppedOperations: 0,
          },
        },
        audits: [{ ref: "pi.read", args: { path: "src/a.ts", limit: 10 } }],
        phases: ["build"],
      },
    },
  });

const writeSession = (agentDir: string, cwd: string, name: string, mtime: Date): string => {
  const dir = path.join(agentDir, "sessions", encodeCwdDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${sessionLine()}\n`);
  fs.utimesSync(file, mtime, mtime);
  return file;
};

describe("projectSessionFiles", () => {
  it("lists the newest project sessions first", () => {
    const agentDir = makeTempDir();
    const older = writeSession(agentDir, "/repo", "a.jsonl", new Date(2020, 0, 1));
    const newer = writeSession(agentDir, "/repo", "b.jsonl", new Date(2021, 0, 1));
    expect(projectSessionFiles(agentDir, "/repo")).toEqual([newer, older]);
    expect(projectSessionFiles(agentDir, "/repo", 1)).toEqual([newer]);
    expect(projectSessionFiles(agentDir, "/missing")).toEqual([]);
  });
});

describe("measureSessionCorpus", () => {
  it("measures sessions newest-first, skips trace-less files, and trends oldest to newest", () => {
    const agentDir = makeTempDir();
    writeSession(agentDir, "/repo", "old.jsonl", new Date(2020, 0, 1));
    writeSession(agentDir, "/repo", "new.jsonl", new Date(2021, 0, 1));
    const quietDir = path.join(agentDir, "sessions", encodeCwdDir("/repo"));
    fs.writeFileSync(path.join(quietDir, "quiet.jsonl"), "no fabric content here\n");
    fs.utimesSync(
      path.join(quietDir, "quiet.jsonl"),
      new Date(2022, 0, 1),
      new Date(2022, 0, 1),
    );
    const result = measureSessionCorpus({
      files: projectSessionFiles(agentDir, "/repo"),
    });
    expect(result.files).toHaveLength(3);
    expect(result.sessions.map((session) => path.basename(session.file))).toEqual([
      "new.jsonl",
      "old.jsonl",
    ]);
    expect(result.latest?.totals.operations).toBe(1);
    expect(result.trend.count).toBe(2);
    expect(result.trend.slopePerStep).toBe(0);
  });

  it("measures against the provided surface and carries the digest", () => {
    const agentDir = makeTempDir();
    const file = writeSession(agentDir, "/repo", "s.jsonl", new Date(2024, 0, 1));
    const surface: EntropySurfaceSnapshot = {
      version: 1,
      actions: [
        {
          ref: "pi.read",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["path", "limit"],
            properties: { path: { type: "string" }, limit: { type: "integer" } },
          },
        },
      ],
    };
    const result = measureSessionCorpus({ files: [file], surface, catalogDigest: "deadbeef" });
    expect(result.sessions).toHaveLength(1);
    expect(result.latest?.catalogDigest).toBe("deadbeef");
    expect(result.latest?.staticFreedom).toBe(1.5);
    expect(result.latest?.score).toBe(0.375);
    expect(result.latest?.staticScore).toBe(0.375);
    expect(result.latest?.behavioralScore).toBe(0);
  });

  it("handles an empty corpus", () => {
    const result = measureSessionCorpus({ files: [] });
    expect(result.sessions).toEqual([]);
    expect(result.latest).toBeUndefined();
    expect(result.trend).toEqual({ count: 0, slopePerStep: 0 });
  });
});

describe("trendFromScores", () => {
  it("computes the least-squares slope exactly", () => {
    expect(trendFromScores([0.6, 0.4, 0.2])).toMatchObject({
      count: 3,
      first: 0.6,
      last: 0.2,
      slopePerStep: -0.2,
    });
    expect(trendFromScores([])).toEqual({ count: 0, slopePerStep: 0 });
    expect(trendFromScores([5])).toEqual({ count: 1, first: 5, last: 5, slopePerStep: 0 });
  });
});
