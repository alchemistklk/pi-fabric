#!/usr/bin/env node
// Deterministic tool-entropy certification. Measures fixed corpora with the
// versioned entropy meter, verifies the exact math, proves the ratchet
// (compile proposals never increase the score and converge), exercises the
// ledger store, and ingests synthetic session JSONL — all offline, with no
// model and no clocks inside the measured values.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ENTROPY_METRIC_VERSION,
  MAX_ENTROPY_LEDGER_ENTRIES,
  appendEntropyLedgerEntry,
  applyProposalsToSurface,
  entropyDirectory,
  entropyReportHash,
  entropyTracesFromSessionJsonl,
  entropyTrend,
  evaluateGate,
  loadEntropyLedger,
  measureEntropy,
  proposeEntropyReductions,
} from "../../dist/entropy/index.js";

const defaultAgentDir = () =>
  process.env.PI_CODING_AGENT_DIR
    ? process.env.PI_CODING_AGENT_DIR
    : path.join(os.homedir(), ".pi", "agent");

const op = (ref, args, outcome = "succeeded", failureStage) => ({
  ref,
  args,
  outcome,
  ...(failureStage ? { failureStage } : {}),
});
const trace = (operations, taskKey) => ({
  operations,
  ...(taskKey ? { taskKey } : {}),
});
const surfaceOf = (actions) => ({ version: 1, actions });

const convergedTraces = () => [
  trace(
    [
      op("pi.read", { path: "src/a.ts", limit: 50 }),
      op("pi.read", { path: "src/b.ts", limit: 50 }),
      op("pi.edit", { path: "src/a.ts" }),
      op("pi.bash", { command: "bun test" }),
    ],
    "converged",
  ),
];

const convergedSurface = () =>
  surfaceOf([
    {
      ref: "pi.read",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path", "limit"],
        properties: { path: { type: "string" }, limit: { type: "integer" } },
      },
    },
    {
      ref: "pi.edit",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: { path: { type: "string" } },
      },
    },
    {
      ref: "pi.bash",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["command"],
        properties: { command: { type: "string" } },
      },
    },
  ]);

const wobbleTraces = () => [
  trace(
    [
      op("pi.read", { path: "src/x.ts", limit: 50 }),
      op("pi.grep", { path: "src", limit: 20 }),
      op("pi.edit", { path: "src/x.ts" }),
    ],
    "flaky-edit",
  ),
  trace(
    [
      op("pi.grep", { path: "src", limit: 20 }),
      op("pi.read", { path: "src/x.ts", limit: 50 }),
      op("pi.edit", { path: "src/x.ts" }),
    ],
    "flaky-edit",
  ),
  trace(
    [
      op("memory.expand", { session: "s1" }),
      op("memory.expand", { session: "s1" }, "failed", "validate"),
      op("memory.expand", { session: "s1", entryId: "e1" }, "failed", "prepare"),
      op("memory.expand", { session: "s1" }),
      op("fabric.discovery.search", { limit: 5 }),
      op("fabric.workflow.phase", { name: "verify", id: "p1", total: 1 }),
      op("pi.bash", { command: "vitest run" }, "failed", "invoke"),
      op("pi.bash", { command: "vitest run" }),
    ],
    "wobble",
  ),
];

const ratchetTraces = () => [
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

const ratchetSurface = () =>
  surfaceOf([
    {
      ref: "mcp.report.render",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["format"],
        properties: { format: { type: "string" } },
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
  { kind: "keyAlias", ref: "memory.expand", from: "sessionId", to: "session" },
];

const structureTraces = () => [
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

const ingestionJsonl = () => {
  const envelope = {
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
    counts: {
      droppedValues: 0,
      truncatedValues: 0,
      redactedValues: 0,
      droppedOperations: 0,
    },
  };
  return [
    "{ not json",
    JSON.stringify({
      id: "entry-0",
      type: "message",
      message: { role: "user", content: "hi" },
    }),
    JSON.stringify({
      id: "entry-1",
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "fabric_exec",
        content: [{ type: "text", text: "ok" }],
        details: { success: true, trace: envelope, audits: [], phases: ["build"] },
      },
    }),
    "",
  ].join("\n");
};

export const runEntropyCertification = async (options = {}) => {
  const checks = [];
  const check = (id, passed, evidence) => {
    checks.push({ id, passed: Boolean(passed), evidence: evidence ?? "" });
  };

  // Determinism: identical inputs must produce an identical report hash.
  const wobble = measureEntropy({ traces: wobbleTraces() });
  const wobbleAgain = measureEntropy({ traces: wobbleTraces() });
  check(
    "determinism-double-run",
    entropyReportHash(wobble) === entropyReportHash(wobbleAgain),
    `hashes ${entropyReportHash(wobble)} vs ${entropyReportHash(wobbleAgain)}`,
  );

  // Converged corpus: canonical calls on a tight surface score exactly.
  const converged = measureEntropy({
    traces: convergedTraces(),
    surface: convergedSurface(),
  });
  check(
    "converged-corpus-exact",
    converged.score === 0.21875 &&
      converged.staticFreedom === 3.5 &&
      converged.shapeEntropyBits === 0 &&
      converged.churnRate === 0 &&
      converged.navigationRatio === 0 &&
      converged.flowEntropyBits === 0 &&
      converged.totals.succeeded === 4 &&
      converged.totals.actionOperations === 4,
    `score ${converged.score} static ${converged.staticFreedom} succeeded ${converged.totals.succeeded}`,
  );

  // Wobble corpus: exact math for every entropy species.
  const expand = wobble.refs.find((ref) => ref.ref === "memory.expand");
  check(
    "wobble-math-exact",
    Boolean(expand) &&
      expand.shapeEntropyBits === 0.811278 &&
      expand.failureStageEntropyBits === 1 &&
      expand.churnRate === 0.48 &&
      wobble.churnRate === 0.32 &&
      wobble.flowEntropyBits === 0.666667 &&
      wobble.navigationRatio === 0.083333 &&
      wobble.totals.invocationRejectionsPer1k === 166.666667,
    `shape ${expand?.shapeEntropyBits} stages ${expand?.failureStageEntropyBits} churn ${wobble.churnRate} flow ${wobble.flowEntropyBits}`,
  );

  // Ratchet: propose → apply → re-measure → gate, then converge.
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
  const kinds = proposals.map((proposal) => proposal.kind);
  check(
    "ratchet-proposals",
    kinds.length === 3 &&
      kinds.filter((kind) => kind === "enum-tighten").length === 1 &&
      kinds.filter((kind) => kind === "modal-rename").length === 1 &&
      kinds.filter((kind) => kind === "noise-quarantine").length === 1,
    `kinds ${kinds.join(",")}`,
  );
  const originalSurface = ratchetSurface();
  const originalJson = JSON.stringify(originalSurface);
  const compiledSurface = applyProposalsToSurface(originalSurface, proposals);
  check(
    "surface-apply-purity",
    JSON.stringify(originalSurface) === originalJson,
    "applyProposalsToSurface mutated its input",
  );
  const retiredRows = ratchetRepairs().filter(
    (row) =>
      !proposals.some(
        (proposal) =>
          proposal.kind === "modal-rename" &&
          proposal.level === "key" &&
          proposal.ref === row.ref &&
          proposal.from === row.from,
      ),
  );
  const after = measureEntropy({
    traces: ratchetTraces(),
    surface: compiledSurface,
    repairs: retiredRows,
  });
  const gate = evaluateGate(before, after);
  check(
    "ratchet-monotone",
    gate.passed &&
      before.score === 0.333435 &&
      after.score === 0.179789 &&
      gate.delta === -0.153646,
    `score ${before.score} → ${after.score} delta ${gate.delta} reasons ${gate.reasons.join("; ")}`,
  );
  const roundTwo = proposeEntropyReductions({
    report: after,
    traces: ratchetTraces(),
    surface: compiledSurface,
    repairs: retiredRows,
  });
  check(
    "ratchet-converged",
    roundTwo.length === 0,
    `round-2 proposals ${roundTwo.map((proposal) => proposal.kind).join(",")}`,
  );

  // Structure proposals: sequence fusion and overload splitting.
  const structureReport = measureEntropy({ traces: structureTraces() });
  const structureProposals = proposeEntropyReductions({
    report: structureReport,
    traces: structureTraces(),
  });
  const fuse = structureProposals.find(
    (proposal) => proposal.kind === "sequence-fuse",
  );
  const split = structureProposals.find(
    (proposal) => proposal.kind === "overload-split",
  );
  check(
    "structure-proposals",
    Boolean(fuse) &&
      fuse.occurrences === 2 &&
      JSON.stringify(fuse.sequence) ===
        JSON.stringify(["pi.read", "pi.grep", "pi.edit"]) &&
      Boolean(split) &&
      split.clusters.length === 2 &&
      JSON.stringify(split.clusters.map((cluster) => cluster.keys)) ===
        JSON.stringify([
          ["key", "value"],
          ["limit", "prefix"],
        ]) &&
      !structureProposals.some(
        (proposal) =>
          proposal.kind === "enum-tighten" || proposal.kind === "noise-quarantine",
      ),
    `proposals ${structureProposals.map((proposal) => proposal.kind).join(",")}`,
  );

  // Session JSONL ingestion: malformed and non-trace lines are skipped;
  // guarded trace envelopes become meter traces.
  const ingestedTraces = entropyTracesFromSessionJsonl(
    ingestionJsonl().split("\n"),
  );
  const ingestionReport = measureEntropy({ traces: ingestedTraces });
  check(
    "session-jsonl-ingestion",
    ingestedTraces.length === 1 &&
      ingestionReport.totals.operations === 2 &&
      ingestionReport.totals.succeeded === 1 &&
      ingestionReport.totals.failed === 1,
    `traces ${ingestedTraces.length} ops ${ingestionReport.totals.operations}`,
  );

  // Ledger: round trip, cap, exact trend slope, and damage behavior.
  const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-entropy-"));
  let ledgerEntries = 0;
  let ledgerSlope = 0;
  let ledgerLast = 0;
  let capEntries = 0;
  let capLast = -1;
  let damageError = "";
  let appendThrew = false;
  let damagePreserved = false;
  try {
    for (const score of [0.6, 0.4, 0.2]) {
      appendEntropyLedgerEntry(ledgerDir, {
        catalogDigest: "digest-test",
        score,
        operations: 10,
        invocationRejectionsPer1k: 0,
        source: "certify-entropy",
      });
    }
    const loaded = loadEntropyLedger(ledgerDir);
    const trend = entropyTrend(loaded.ledger);
    ledgerEntries = loaded.ledger.entries.length;
    ledgerSlope = trend.slopePerEntry;
    ledgerLast = trend.lastScore ?? 0;
    check(
      "ledger-round-trip",
      !loaded.error &&
        ledgerEntries === 3 &&
        ledgerSlope === -0.2 &&
        ledgerLast === 0.2,
      `entries ${ledgerEntries} slope ${ledgerSlope} last ${ledgerLast} error ${loaded.error ?? "none"}`,
    );
    for (let index = 0; index < MAX_ENTROPY_LEDGER_ENTRIES + 10; index++) {
      appendEntropyLedgerEntry(ledgerDir, {
        catalogDigest: "digest-test",
        score: index,
        operations: 10,
        invocationRejectionsPer1k: 0,
        source: "certify-entropy",
      });
    }
    const capped = loadEntropyLedger(ledgerDir);
    capEntries = capped.ledger.entries.length;
    capLast =
      capped.ledger.entries[capped.ledger.entries.length - 1]?.score ?? -1;
    check(
      "ledger-cap",
      capEntries === MAX_ENTROPY_LEDGER_ENTRIES &&
        capLast === MAX_ENTROPY_LEDGER_ENTRIES + 10 - 1,
      `entries ${capEntries} last ${capLast}`,
    );
    const damagedPath = path.join(ledgerDir, "ledger.json");
    fs.writeFileSync(damagedPath, "{oops", "utf8");
    const damaged = loadEntropyLedger(ledgerDir);
    damageError = damaged.error ?? "";
    try {
      appendEntropyLedgerEntry(ledgerDir, {
        catalogDigest: "digest-test",
        score: 1,
        operations: 1,
        invocationRejectionsPer1k: 0,
        source: "certify-entropy",
      });
    } catch {
      appendThrew = true;
    }
    damagePreserved = fs.readFileSync(damagedPath, "utf8") === "{oops";
  } finally {
    fs.rmSync(ledgerDir, { recursive: true, force: true });
  }
  check(
    "ledger-damage-surfaced",
    damageError.length > 0 && appendThrew && damagePreserved,
    `error "${damageError}" appendThrew ${appendThrew} preserved ${damagePreserved}`,
  );

  // Real session corpus (opt-in).
  let corpus;
  if (options.sessionsDir) {
    const sessionsDir = options.sessionsDir;
    if (!fs.existsSync(sessionsDir)) {
      check("corpus-mode", false, `sessions directory not found: ${sessionsDir}`);
    } else {
      const files = fs
        .readdirSync(sessionsDir)
        .filter((name) => name.endsWith(".jsonl"))
        .sort();
      const lines = [];
      for (const file of files) {
        lines.push(
          ...fs.readFileSync(path.join(sessionsDir, file), "utf8").split("\n"),
        );
      }
      const traces = entropyTracesFromSessionJsonl(lines);
      corpus = measureEntropy({ traces, catalogDigest: "(sessions)" });
      check(
        "corpus-mode",
        corpus.totals.operations > 0,
        `files ${files.length} traces ${traces.length} operations ${corpus.totals.operations}`,
      );
      if (options.record) {
        const agentDir = options.agentDir ?? defaultAgentDir();
        appendEntropyLedgerEntry(entropyDirectory(agentDir), {
          catalogDigest: corpus.catalogDigest,
          score: corpus.score,
          operations: corpus.totals.operations,
          invocationRejectionsPer1k: corpus.totals.invocationRejectionsPer1k,
          source: "certify-entropy",
        });
      }
    }
  }

  const evaluation = {
    passed: checks.every((entry) => entry.passed),
    checks,
    failed: checks.filter((entry) => !entry.passed).map((entry) => entry.id),
  };
  return {
    kind: "pi-fabric.entropy-certification",
    version: 1,
    metricVersion: ENTROPY_METRIC_VERSION,
    fixtures: {
      converged: {
        score: converged.score,
        staticFreedom: converged.staticFreedom,
        totals: converged.totals,
      },
      wobble: {
        score: wobble.score,
        shapeEntropyBits: wobble.shapeEntropyBits,
        failureStageEntropyBits: wobble.failureStageEntropyBits,
        churnRate: wobble.churnRate,
        navigationRatio: wobble.navigationRatio,
        flowEntropyBits: wobble.flowEntropyBits,
      },
      ratchet: {
        beforeScore: before.score,
        afterScore: after.score,
        delta: gate.delta,
        proposals,
        gate,
      },
      structure: {
        proposals: structureProposals,
      },
      ledger: {
        entries: ledgerEntries,
        slope: ledgerSlope,
        cappedEntries: capEntries,
      },
      ingestion: {
        traces: ingestedTraces.length,
        operations: ingestionReport.totals.operations,
      },
    },
    ...(corpus ? { corpus } : {}),
    evaluation,
  };
};

export const formatEntropyHumanReport = (report) => {
  const lines = [
    `Entropy certification (metric v${report.metricVersion})`,
    `  converged: score ${report.fixtures.converged.score} · static freedom ${report.fixtures.converged.staticFreedom}`,
    `  wobble: shape ${report.fixtures.wobble.shapeEntropyBits} bits · stages ${report.fixtures.wobble.failureStageEntropyBits} · churn ${report.fixtures.wobble.churnRate} · flow ${report.fixtures.wobble.flowEntropyBits}`,
    `  ratchet: ${report.fixtures.ratchet.beforeScore} → ${report.fixtures.ratchet.afterScore} (delta ${report.fixtures.ratchet.delta}) · ${report.fixtures.ratchet.proposals.length} proposals`,
  ];
  if (report.corpus) {
    lines.push(
      `  corpus: ${report.corpus.totals.operations} operations · score ${report.corpus.score} · rejections/1k ${report.corpus.totals.invocationRejectionsPer1k}`,
    );
  }
  for (const entry of report.evaluation.checks) {
    lines.push(
      `  ${entry.passed ? "✓" : "✗"} ${entry.id}${entry.passed ? "" : ` — ${entry.evidence}`}`,
    );
  }
  lines.push(report.evaluation.passed ? "  PASS" : "  FAIL");
  return lines.join("\n");
};
