#!/usr/bin/env node
import fs from "node:fs";
import { formatEntropyHumanReport, runEntropyCertification } from "./certification/run-entropy.mjs";

const argumentValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

try {
  const report = await runEntropyCertification({
    sessionsDir: argumentValue("--sessions"),
    surfacePath: argumentValue("--surface"),
  });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const jsonPath = argumentValue("--json");
  if (jsonPath) fs.writeFileSync(jsonPath, json, "utf8");
  process.stdout.write(`${formatEntropyHumanReport(report)}\n\n${json}`);
  if (!report.evaluation.passed) process.exitCode = 1;
} catch (error) {
  process.stderr.write(
    `Entropy certification failed to execute: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
