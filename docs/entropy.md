# Tool entropy

Tool entropy is the corrective freedom a tool surface leaves open per unit of
work: the number of distinct ways a call can be non-canonical, weighted by
how often models exercise them. The [catalog repair table](repairs.md)
is the running profile of that freedom: every promoted row is one dimension
the surface exposed and a model hit. The entropy meter turns the repairs KPI
(*repeat invocation fingerprints → 0*) into a measured quantity, and the
compiler loop drives it down and keeps it there.

Everything is deterministic by construction. The meter is a pure function over
typed artifacts Fabric already persists: trace V1 operations, live JSON
schemas, and the repair table. No model judges anything, no prose is parsed,
and the same inputs plus the same `ENTROPY_METRIC_VERSION` always produce the
same report, which is what makes the score bisectable and CI-gateable.

## Inputs

- **Traces**: `FabricExecutionTraceV1` operations (`ref`, projected `args`,
  `outcome`, `failureStage`, `sequence`) extracted from session JSONL tool
  result details. Trace V1 is deliberately prose-free, which is exactly what
  makes deterministic measurement possible.
- **Surface**: an optional snapshot of `{ ref, inputSchema }` actions. When
  present the meter adds static freedom; without it the report covers
  behavioral terms only.
- **Repairs**: the normalized catalog repair table (`keyAlias` /
  `actionAlias` rows). Each row is a standing lexicon tax on its target ref.
- **Audits**: persisted verbatim call arguments (`details.audits`). They are
  the value corpus for enum-tighten: trace V1 projects values away per ref,
  while audits carry every argument the call used. They stay local to the
  session record.

## The metric (v1)

`measureEntropy({ traces, surface?, repairs?, catalogDigest? })` returns a
report with per-ref and global terms, all rounded to 1e-6:

| Term | Formula | Weight |
| --- | --- | --- |
| Shape entropy | Shannon entropy (bits) over canonical argument-shape signatures per ref, calls-weighted | 1 |
| Failure-stage entropy | Entropy over `failureStage` among failed ops per ref, failed-weighted | 1 |
| Retry churn | Mean normalized Levenshtein distance between a failed op's signature and the next same-ref signature | 4 |
| Navigation | `fabric.discovery.*` operations per action operation | 4 |
| Flow entropy | Occurrence-weighted entropy over action-ref sequences per task key | 1 |
| Lexicon tax | Repair rows targeting the ref | 2 |
| Static freedom | Per-schema freedom score (below) for called refs | 0.25 |

The global `score` is `(Σ per-ref scores + navigation + flow) / max(1,
succeeded action operations)`. Lower is better; the compiler's contract is
that it never increases. The report decomposes it into `staticScore` (the
surface share: static freedom of the refs the corpus used) and
`behavioralScore` (everything models exercised: wobble, churn, rejections,
navigation, flow, lexicon tax).

Additional totals: `invocationRejections` counts failures at `resolve`,
`prepare`, or `validate`: the offline residue class behind repair
fingerprints. `invocationRejectionsPer1k` is that rate per 1,000 action
operations and is the entropy production signal: it should trend to zero as
the surface converges, and it spikes when a new model or tool arrives.

### Fingerprints

- **Shape signature**: sorted parameter names with a bounded value-type tag
  (`(limit:num,path:str)`), nested objects to depth 3, at most 32 keys. Key
  order and value contents never matter, only the shape the model chose.
- **Static freedom**: per JSON Schema parameter: free string 1.0, enum
  `min(1, log2(k)/6)`, literal/const 0, number 0.5, boolean 0.1, arrays
  `0.5 + 0.5·items`, objects recursed; optional parameters add 0.25,
  `additionalProperties !== false` adds 0.5, free-form objects score 1.0.
  Computable with an empty corpus, which is what lets the compiler score
  candidate surfaces before deployment.

### What good means

- **Behavioral entropy → 0.** The bits of freedom models exercised, per
  successful call. Zero means no call in the corpus needed correcting. This
  is the primary target and the general form of the repairs KPI (repeat
  invocation fingerprints → 0).
- **Surface share shrinks by compilation, never by behavior.** It is the
  priced potential of the refs the corpus used. It falls only when
  a compiled surface (enum-tighten, renames, splits, quarantines) removes
  real freedom; track it across surface releases, bounded by function.
- **Slope ≤ 0.** The per-session least-squares slope is the ratchet line:
  flat means the surface converged, negative means it is compiling down,
  positive means something regressed (a new model, a new tool, or a schema
  change).
- `/fabric entropy` prints `ratchet holding` when the latest session logged
  zero invocation rejections and the slope is at or below zero, and
  `ratchet slipping` otherwise.

## Proposals

`proposeEntropyReductions({ report, traces, surface?, repairs? })` emits
reviewable, evidence-carrying proposals with fixed thresholds:

- `enum-tighten`: a parameter with ≥ 8 observations, 2–8 distinct values,
  and a ≥ 50% top share compiles into an enum. Value observations come from
  the verbatim audits when supplied
  (`entropyValueObservationsFromSessionJsonl`); the projected trace args
  are the fallback. Skipped when the live schema's enum already covers
  every observed value.
- `modal-rename`: a repair row whose target ref is called: compile the
  modal spilled spelling into the schema (rename the declared key or
  action) and retire the row. Skipped when the rename is already compiled
  in. Renamed keys retire their repair rows because the spilled spelling
  becomes canonical, so the row can no longer fire.
- `overload-split`: a ref with ≥ 1.0 bits of shape entropy and ≥ 2 disjoint
  key-set clusters with ≥ 2 calls each splits into separate actions.
- `sequence-fuse`: a contiguous action sequence of 3–6 refs with ≥ 2
  distinct refs that occurs ≥ 2 times fuses into a composite action or
  skill.
- `noise-quarantine`: a ref with ≥ 3 calls, more failures than successes,
  and ≥ 1.0 bits of failure-stage entropy hides from the model-facing
  catalog.

`applyProposalsToSurface` applies the mechanical subset (enum-tighten,
noise-quarantine, modal-rename) as a pure surface rewrite. Overload-split and
sequence-fuse author new composite definitions, so they stay review-only.

## The gate (ratchet)

`evaluateGate(before, after)` passes only when the compiled surface does not
increase the score and preserves every successful call. The compile step is
measure → propose → apply → re-measure → gate; a gate failure rejects the
diff. Monotonicity is measured, never argued. A converged surface stops
proposing, which the certification proves by requiring an empty second
round.

## On-demand measurement

Session JSONL is the source of truth, so nothing is recorded. `/fabric
entropy` reads the newest project sessions (window of 8 files, newest first
by mtime), measures each against the live surface snapshot, and reports the
latest session's score plus the least-squares slope across the window's
session scores (`trendFromScores`). Lines without a trace envelope are
skipped by a cheap substring filter before parsing, so large logs stay
fast. The repair table remains the only durable derived artifact because it
is the only one that changes runtime behavior.

## Commands and certification

```text
/fabric entropy                     # live surface freedom + observed session entropy trend
/fabric entropy export [path]      # write the live surface snapshot (default <agent dir>/fabric/entropy/surface.json)
```

Repo-side only (development and CI; these scripts are not part of the
installed package):

```text
bun run certify:entropy                                     # offline fixtures, exact math, ratchet proof, ingestion
bun run certify:entropy --sessions <dir> --surface <snap>   # measure an arbitrary session corpus
```

`/fabric entropy` measures on demand: the newest project sessions are read
from the session logs, measured against the live surface, and the trend is
the per-session slope. `/fabric entropy export [path]` snapshots the live
registry through the discovery path (read-only, authorization-free), defaulting
to `<agent dir>/fabric/entropy/surface.json` beside the repair table, as
`{ version: 1, actions: [{ ref, inputSchema }] }`, sorted by ref so it
hashes stably. Pass an exported snapshot with `--surface` to measure a
copied corpus against the surface it ran on; the report then carries the
surface hash as its catalog digest, so scores compare like against like.

The certification harness exits nonzero on any failed check, mirroring
`certify:context`: determinism (double-run hash equality), exact metric math
on fixed corpora, the full ratchet loop with convergence, surface-apply
purity, synthetic session-JSONL ingestion, and audit-derived value
observations. The `Entropy` GitHub workflow runs the certification on every
push to `main` and weekly, uploading the JSON report as an artifact; a red
certification fails the build, so the metric and ratchet stay verified per
commit.

## Determinism contract

- Fixed canonicalization, fixed thresholds, fixed weights; changes bump
  `ENTROPY_METRIC_VERSION` so ledger trends never mix formulas.
- No clocks, randomness, or model calls inside measured values.
- Only typed records are consumed; prose is never classified, the same
  discipline as [schema enforcement](schema-enforcement.md).
- The report hashes stably (`entropyReportHash`), so per-commit scores are
  bisectable.

## Limitations

- Trace V1 projects arguments per ref (grep patterns, edit contents, and
  external arguments are dropped), so shape signatures see the projected
  key sets. Value-level passes read the verbatim audits through
  `entropyValueObservationsFromSessionJsonl`, which keeps enum-tighten
  working for value-dropped parameters as long as the session record (or an
  exported corpus) travels with the measurement.
- The gate proves score monotonicity on the retained corpus, not equivalence
  of future behavior. Quarantine preconditions (more failures than
  successes) carry the replay-safety argument for retired refs.
- Flow entropy groups executions by the persisted first workflow phase (or
  `(none)`), which is a coarse task key.
- The on-demand trend covers the newest project sessions only (mtime
  ordered): sessions the user prunes leave the trend, and the slope is only
  as strong as the window.
