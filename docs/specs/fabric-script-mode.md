# Structured shell-script payloads for `fabric_exec`

Status: proposed for implementation and local dogfood  
Delivery: a separate change from `pi.bash` per-call `cwd` and PR #71

## Objective

Add a flat, model-facing `script` input to `fabric_exec` for requests whose payload is one complete shell program. Fabric must carry the script out of TypeScript source text, compile it onto the existing `strings`/`π` path, and execute it through the existing QuickJS → `pi.bash` path.

The feature succeeds when large shell programs no longer require JSON → TypeScript-string → shell triple escaping, while ordinary Fabric programs continue to use `code`.

## Evidence

Corpus figures below were re-measured on 2026-08-28 with `measure-fabric-failures.mjs` over `~/.pi/agent/sessions`, deduplicated by `toolCallId`, across a window of 2026-08-19 → 2026-08-28 (8 recorded days). They supersede an earlier snapshot; re-measure rather than quoting them once the window moves.

| Measure | Count | Share |
| --- | ---: | ---: |
| `fabric_exec` calls with a string `code` argument | 7,438 | — |
| Static rejections (type errors, code never ran) | 140 | 1.88% of calls |
| Static rejections in the syntax / embedded-text bucket | 77 | 55.0% of static |
| Syntax-bucket failures whose own source contains `pi.bash(` | 37 | 26.4% of static, 48.1% of syntax |
| Static rejections mentioning `pi.bash` under any cause | 89 | 63.6% of static |
| `pi.bash` `cwd` rejections (the separate change) | 26 | 18.6% of static |

Two caveats on how to read that table. The buckets are regexes over diagnostic text rather than parser-confirmed classifications, and they overlap: the per-cause counts sum past 140 because one rejection can match several. Separately, the `cwd` bucket and the syntax bucket are fully disjoint in this window — zero rejections appear in both — which is the concrete reason this change and the `cwd` change are independent rather than merely scheduled apart.

The 37-call figure is the honest size of the target: about a quarter of static rejections, not a third, and under half of syntax rejections rather than the majority. The corpus is also one operator's 8-day local window, self-selected toward this repository's own work, so it sizes a problem worth fixing — not a rate that generalizes to other users.

An anonymized paired evaluation modeled the observed distribution of heredocs, pipes, loops, command substitutions, sed/awk backreferences, embedded Python/Node programs, and payload sizes. Across 36 paired task runs:

| Metric | Baseline | Structured script |
| --- | ---: | ---: |
| Static failures | 9/36 | 2/36 |
| Completed validly scored tasks | 34/34 | 34/34 |
| Tool calls | 65 | 66 |
| Mean wall time | 22.44 s | 22.07 s |
| Processed tokens | 248,540 | 268,259 |

The candidate selected `script` in 26/36 runs. Those 26 runs had zero static failures. These are local, synthetic results rather than production proof; they justify engineering and dogfood, not a success claim for upstream users.

Read the paired table as directional only. The task distribution was modeled rather than sampled from live traffic, and at n=36 the 9→2 static-failure difference carries a wide interval: it is enough to motivate building the feature, not enough to calibrate a threshold. The corpus table above is the firmer half of the evidence, and it measures the problem, not this solution. Unlike the corpus figures, these paired runs have not been re-measured; treat every number in this section as a stale snapshot until reproduced.

## Invariants

- `fabric_exec` remains the only model-facing execution path in effective full-code mode.
- A script runs through the existing type check, QuickJS runtime, provider registry, approval controller, lifecycle replay, audit trace, and `pi.bash` implementation.
- The feature exposes no native Bash tool and introduces no new executor, child process, stdin transport, or temporary-file transport.
- Existing `code + strings` behavior remains byte-for-byte compatible.
- Model choice is semantic, not size-based: a complete shell program may use `script`; multi-tool orchestration uses `code`; edit/write payloads continue to use `strings`.
- The implementation adds no system-prompt rule or recovery hint. Discoverability comes from the flat outer tool schema.

## Model-facing contract

Accept either:

```json
{
  "code": "const value = await pi.read('package.json'); return value;"
}
```

or:

```json
{
  "script": "set -eu\nprintf '%s\\n' 'done'"
}
```

Rules:

- `code` and `script` are mutually exclusive.
- At least one must be a string after compatibility preparation.
- `script` may coexist with `strings`, `display`, budgets, and `resultFormat`.
- Fabric reserves `strings.__fabric_script`; a caller-provided collision fails before execution.
- Script mode returns the Bash text output as the outer Fabric value.
- A script value is preserved exactly as received. Fabric performs no shell escaping, interpolation, rewriting, or normalization.

### Bash execution options

A `code` program reaches `pi.bash`'s option object directly; a bare compiled call would not. Two Bash behaviors are load-bearing often enough that script mode must carry them, because without them the script path is strictly weaker than the `code` path it is meant to replace:

- `settle` — `PiToolsProvider` throws on a failed nested tool result, so an ordinary nonzero exit (a failing test run, a `grep` with no match) would abort the Fabric call and discard the output instead of returning it as evidence. This is exactly the case the existing prompt guidelines answer with `settle: true`.
- `timeout` — Bash timeout is measured in seconds; a long suite otherwise has no way to raise the default other than retrying a timed-out call.

Both are exposed as flat, optional, script-only scalars:

- `timeout?: number` (seconds, minimum 1) and `settle?: boolean`.
- Both are rejected before execution when `script` is absent; they are not a second way to configure a `code` program, which already has the real option object.
- Both compile into the nested call's option object rather than into the script text.

Per-call `cwd` is deliberately excluded here — it ships on its own branch and is a follow-up once that change lands upstream. Any other Bash option stays out of scope: a payload needing one is a `code` payload.

The model-facing schema stays flat:

```ts
{
  code?: string;
  script?: string;
  timeout?: number;   // script only, seconds
  settle?: boolean;   // script only
  strings?: Record<string, string>;
  // existing scalar/optional fields
}
```

Do not introduce a nested call IR, generic batch format, or `oneOf` tree with duplicated object branches. The existing schema deliberately avoids high-entropy nested tool arguments.

One naming collision to keep straight while reading the runtime: the guest-type near-miss repairs already alias a nested `pi.bash({ script })` to `command`. That inner alias is unrelated to this outer `fabric_exec` argument and neither one should be implemented in terms of the other.

## Deterministic compilation

`prepareFabricExecArguments` compiles:

```json
{
  "script": "<payload>",
  "strings": { "note": "keep" }
}
```

to the existing internal representation:

```json
{
  "code": "const result = await pi.bash(π.__fabric_script); return result.output;",
  "strings": {
    "note": "keep",
    "__fabric_script": "<payload>"
  }
}
```

With execution options, the compiled call carries them in the nested option object and the outer scalars are consumed:

```json
{
  "script": "<payload>",
  "timeout": 600,
  "settle": true
}
```

compiles to:

```json
{
  "code": "const result = await pi.bash(π.__fabric_script, { timeout: 600, settle: true }); return result.output;",
  "strings": { "__fabric_script": "<payload>" }
}
```

Emit only the options the caller actually supplied, so the default case stays byte-for-byte identical to the bare compiled program above. The compiled program is a fixed template selected by which options are present — never string-built from caller values, which stay in the option object as typed scalars.

Compilation must be idempotent. A second preparation pass sees canonical `code + strings` and leaves the object unchanged.

`strings.__fabric_script` is the authoritative marker for "this call was authored as a script". Everything downstream of preparation — mode gates, rendering, title hints — detects script mode by that key, not by an outer `script` argument, which no longer exists after preparation.

## Mode gates

After `state.ensure(context)` and before `state.execution.execute(...)`, reject script mode unless all conditions hold:

- `state.config.fullCodeMode === true`
- `state.config.schema.mode !== "enforce"`

Schema audit mode may execute the script under its existing audit behavior. Orchestration-only mode must direct the caller to native Pi tools. Schema enforce mode must direct protected mutations to the schema transaction path. Rejection occurs before QuickJS or any nested tool call starts.

The enforce-mode rejection is a policy decision, not a technical limit, and must not be "fixed" during implementation. `effectiveFullCodeMode` is `fullCodeMode || enforceSchema`, so `pi` — and therefore `pi.bash` — is reachable from guest code in enforce mode. Script mode is withheld there on purpose: enforce mode exists to route protected mutations through the schema transaction path, and an opaque shell payload defeats that review. A caller that genuinely needs shell in enforce mode writes it as `code`, where the surrounding program is visible to the same review.

The outer schema may remain stable across modes, but its `script` description must name the supported mode boundary. Do not silently fall back to native Bash.

## Rendering and observability

### Outer call

- Render a script call as Shell, not as user-authored TypeScript, resolving the payload from `strings.__fabric_script` on settled cards and from the streaming `script` argument while arguments are still arriving.
- Apply the existing bounded code-preview rules and terminal sanitization.
- Render the payload once. The constant compiled program is never shown alongside it, and the reserved key is never shown as an ordinary `strings` entry.
- Partial streaming arguments must not throw when `code` is absent.

### Nested call

- The nested call remains `pi.bash` and receives the exact script as its command.
- Approval classification sees the real script, not only the constant compiled code.
- Lifecycle events, previews, audit records, and trace outcomes retain their existing Bash shapes.
- Timeout, cancellation, nonzero exit, output truncation, and `settle: true` behavior match the equivalent hand-written `pi.bash(π.__fabric_script, options)` call.

### Persistence

Pi validates custom-tool arguments before `tool_call` and `execute`, so `prepareArguments` output — not the model's raw object — is what Pi persists and renders. There is therefore no persisted outer `script` argument to preserve, and the implementation must not try to manufacture one by moving compilation out of `prepareArguments`; that would break the host validation order the existing hook comment documents.

- The authored payload is persisted exactly once, as `strings.__fabric_script`, through Pi's normal tool-call transcript behavior. Do not add a parallel copy under a `script` key.
- Durable Fabric traces continue their existing safe projection and must not add a second payload copy.
- Compaction intent may use the declared display metadata; when it would otherwise infer a title from the constant compiled program, it must resolve the payload through `strings.__fabric_script` on the normal title-hint path instead.
- Renderers may still see an uncompiled `script` in partial streaming arguments, the same way they see a not-yet-joined `code` array today. Treat that as a streaming affordance only; the settled card resolves script mode from the marker.

## Implementation brief

Work from the latest upstream `main` on a dedicated branch. Do not base the implementation PR on PR #71; the two changes are logically independent.

### Step 1: Lock the argument contract

Update `src/fabric-exec-arguments.ts` and its focused tests.

Completion criteria:

- Script compilation, caller strings preservation, reserved-key collision, `code + script` conflict, malformed values, and idempotency are all covered by red-then-green tests.
- Existing compatibility cases retain their current identity/no-copy behavior.

### Step 2: Expose the flat schema

Update `src/fabric-exec-tool.ts` so `code` and `script` are optional at schema level and runtime preparation enforces the exclusive contract. Add the script-only `timeout` and `settle` scalars alongside them.

Relaxing `code` from required to optional moves a case host validation used to catch — an argument object with no program — into Fabric's own preparation. That case must fail loudly there; it must not reach QuickJS and surface as an `undefined` program.

Completion criteria:

- A real Pi tool invocation accepts `{script}` before ordinary schema validation.
- `{code}`, root-string code shorthand, and code arrays retain current behavior.
- `{}`, `{code, script}`, and non-string `script` fail before execution with actionable errors routed through the existing argument-error path, asserted on message content rather than on rejection alone.
- `timeout`/`settle` without `script` fail the same way; with `script` they reach the nested option object with the correct units and types.
- The `script`, `timeout`, and `settle` schema descriptions carry the whole discoverability burden, since the feature adds no system-prompt rule or recovery hint. `script`'s description names the supported mode boundary; `code`'s description says when a payload belongs in `code` instead.

### Step 3: Add mode gates

Gate the prepared script invocation using live Fabric state after bootstrap.

Completion criteria:

- Full-code/off and full-code/audit execute.
- Orchestration-only and schema-enforce reject before QuickJS and before nested lifecycle events.
- Reload or configuration changes cannot leave a stale authorization decision.

### Step 4: Render the authored surface

Render script calls through the existing Shell/code-preview components, including partial argument streaming and bounded expansion. Detect script mode from `strings.__fabric_script`; the streaming `script` argument is an affordance for the partial card only, in the same way `code` may still arrive as an unjoined array there.

Completion criteria:

- Collapsed, expanded, partial, resumed, success, and failure cards render without duplication.
- Large scripts obey current preview limits and sanitization.
- The constant compiled TypeScript body is not presented as model-authored code.

### Step 5: Prove approval and lifecycle parity

Add focused provider/integration tests around the compiled nested Bash call.

Completion criteria:

- Approval receives the exact script command and the normal Bash risk.
- `tool_call`, `tool_result`, and `tool_execution_*` events match ordinary nested `pi.bash` calls.
- Audit and trace outcomes cover success, nonzero exit, cancellation, timeout, and denial.
- A `settle: true` script returns a nonzero-exit result as an outer value instead of aborting the Fabric call; without it, the same script fails the way any failed nested `pi.bash` fails today.
- A `timeout` script reaches the host with seconds, not milliseconds.
- No script payload is duplicated into durable trace-safe error fields.

### Step 6: Validate and prepare dogfood

Run the repository's typecheck, build assertions, lazy-graph assertion, full tests, and dead-code check. Update user-facing configuration/interface documentation only after behavior is stable.

Completion criteria:

- All repository checks pass with no skipped regression test.
- A deterministic CLI probe executes a script containing quotes, `${HOME}`, backticks, heredoc syntax, command substitution, and sed backreferences without embedding it in TypeScript.
- A second probe covers the option path end to end: a deliberately nonzero-exit script with `settle: true` returns its output, and a raised `timeout` is honored.
- The local dogfood build has an explicit start time and rollback path.

## Dogfood protocol

Stack the local dogfood build on the current `pi.bash cwd` build if desired, but keep measurement windows and upstream delivery separate.

Run normal work without asking the model to use `script`. Collect at least:

- 3–7 days of use
- 20 natural `script` selections
- 50 Bash-related Fabric calls

Measure:

- script selection count and rate
- Bash syntax failures per Bash-related call
- Bash calls using `code + strings`
- Bash calls with inline payloads
- retries after static rejection
- calls, processed tokens, and elapsed time where available
- script selections on tasks that later require multi-tool code orchestration

Establish the baseline before fixing any numeric gate. The synthetic evaluation is too small and too modeled to calibrate a threshold from, so run the first measurement window against the unmodified build, record the same metrics, and only then set the numeric targets for the script-mode window. Recording a matched baseline is a completion requirement; hitting a particular number is not.

Two gates are unconditional, because they are correctness rather than adoption:

- no script-caused approval, audit, cancellation, timeout, or rendering regression
- no material increase in total tool calls; investigate token growth above 10%

The adoption targets below are starting hypotheses carried over from the synthetic runs, to be replaced by baseline-derived numbers before the window closes. Missing one is a signal to investigate — a discoverability problem, a mode boundary, a wrong default — not by itself a reason to abandon the feature:

- around 60% natural script selection on eligible one-script tasks
- a substantial reduction in Bash syntax failures against the matched baseline, provisionally half

Report every metric as measured, including the ones that moved the wrong way, and state which gate was pre-registered and which was set after seeing the baseline.

Rollback by restoring the prior local package path. Do not remove or alter the independent cwd dogfood build when isolating a script-mode regression.

## Non-goals

- Generic batch or structured multi-tool IR
- Automatic conversion based on payload length
- Host-side guessing of malformed TypeScript string boundaries
- `stdin` support or a temporary-file stdin emulation
- Native Bash exposure in full-code mode
- Edit/write payload modes; those remain `code + strings`
- `process`, `require`, Node compatibility, or executor replacement
- Changes to per-call `cwd`, including exposing it as a script-mode option; that follows the separate `cwd` change
- Any Bash option beyond `timeout` and `settle`; those payloads stay in `code`

## Definition of done

Implementation is complete only when the contract (including the `timeout`/`settle` option path), mode gates, authored-surface rendering, approval/lifecycle parity, repository validation, dogfood instrumentation with a recorded matched baseline, rollback instructions, and user-facing documentation are all present. Local green tests alone are not upstream delivery or dogfood proof.
