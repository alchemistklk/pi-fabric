# Structured shell-script payloads for `fabric_exec`

Status: proposed for implementation and local dogfood  
Delivery: a separate change from `pi.bash` per-call `cwd` and PR #71

## Objective

Add a flat, model-facing `script` input to `fabric_exec` for requests whose payload is one complete shell program. Fabric must carry the script out of TypeScript source text, compile it onto the existing `strings`/`π` path, and execute it through the existing QuickJS → `pi.bash` path.

The feature succeeds when large shell programs no longer require JSON → TypeScript-string → shell triple escaping, while ordinary Fabric programs continue to use `code`.

## Evidence

Every figure below comes from `~/.pi/agent/sessions`, deduplicated by
`toolCallId`, over sessions started 2026-08-19 through the 2026-08-28T06:33:52Z
dogfood build switch — 8 recorded days on the unmodified build. Sessions are
append-only, so these are reproducible; re-measure rather than quoting them once
the window moves.

### The problem, measured

| Measure | Count | Share |
| --- | ---: | ---: |
| `fabric_exec` calls | 7,739 | — |
| — of those, Bash-related | 4,511 | 58.3% of calls |
| Static rejections (type errors, code never ran) | 145 | 1.87% of calls |
| Static rejections in the syntax family | 73 | 50.3% of static |

### What would fix each rejection

Each of the 145 rejections was replayed through Fabric's own type gate and
classified by which change, if any, owns it. The classification is by first
diagnostic plus a count of `pi.*` call sites in the source, not by regex over
diagnostic text alone.

| Owner | Count | Share of static |
| --- | ---: | ---: |
| **This change (`script`)** | **26** | **17.9%** |
| The separate `pi.bash cwd` change | 26 | 17.9% |
| Syntax, but no shell at all — `pi.edit`/`pi.write` payloads | 36 | 24.8% |
| Syntax, shell inside a multi-tool program — stays `code` | 11 | 7.6% |
| `stdin` — a declared non-goal | 3 | 2.1% |
| Other type errors | 43 | 29.7% |

All 26 script-owned rejections are escaping failures and nothing else:
`',' expected` (16), `Unterminated string literal` (4), `'}' expected` (4),
`Invalid character` (2). Fourteen are one-line programs — a single shell command
whose inner quoting closed the TypeScript literal early. Script mode does not
merely reduce this class; the class cannot occur, because the payload never
enters TypeScript.

Three of the rejected payloads were recovered by hand and re-authored as
`script`: each compiles to a program with zero type errors, emits JavaScript, and
preserves the payload byte-for-byte, with the original `settle`/`timeout` intact
in the nested option object.

### Read this honestly

**17.9%, not a quarter.** An earlier draft of this spec counted 37 syntax
rejections "whose own source contains `pi.bash(`" and treated 37 as the target.
That count reproduces exactly — 26 single-shell-call plus 11 multi-tool — but it
conflates two populations. The 11 are shell embedded in programs that also drive
other tools, which the design stance below deliberately keeps in `code`. The
addressable share is a sixth of static rejections, not a quarter.

**The largest syntax bucket is not shell.** Thirty-six rejections are
`pi.edit`/`pi.write` payloads with no shell in them. `strings` + `π.key` already
solves those and long has. That is a discoverability problem, and `script` does
nothing for it — it is a larger bucket than the one this change addresses.

**This measures the problem, not the solution.** These payloads were rejected
before running, so nothing here says whether the same programs would fail at
runtime instead. That is the counter-metric the dogfood protocol exists to
collect, and it is the gate the feature turns on.

**One operator, 8 days, self-selected toward this repository's own work.** It
sizes a problem worth fixing; it is not a rate that generalizes to other users.

### On the earlier paired evaluation

Previous revisions of this spec carried a 36-run paired evaluation reporting a
9→2 drop in static failures. It is removed rather than restated. The repository's
DeepSWE harness could not reproduce it — the reported medians, per-task tool
counts, and wall times are not shapes that harness emits, and it collected no
static-failure metric at all until one was added. Numbers that cannot be
reproduced should not carry a decision. The replay above measures the same thing
against real traffic and can be re-run from recorded sessions at any time.

## Design stance

`script` is syntactic sugar over `code`. It is not a second mode, a sibling surface, or a parallel execution path, and the spec should be read with that framing throughout.

The claim is mechanical, not rhetorical: script mode has no runtime of its own. Compilation produces `code + strings`, and everything from that point on — type check, QuickJS, provider registry, approval controller, lifecycle replay, audit trace, `pi.bash` — is the single existing path. The compiled artifact *is* code. The problem being solved is an authoring failure (JSON → TypeScript-string → shell triple escaping), never a capability gap; nothing in this spec was impossible in `code`, only hard to write correctly.

That framing settles scope questions without re-litigating them. The test for any proposed addition is one question: **can the desugared `code` form do it?**

- If yes, and the sugar can carry it without string-building — `timeout`, `settle`, and later `cwd` — it belongs.
- If no, because the desugared form cannot reach it at all — `strings`, `tokenBudget`, `agentBudget` — it is rejected, not silently accepted.
- If yes, but only by writing a program around the shell call — multiple Bash calls, branching on a result, combining other tools, post-processing output — then the caller wants `code`, and adding it here would rebuild `code` behind a worse syntax. That is the failure mode the non-goals list and the semantic-not-size-based selection rule exist to prevent.

Two consequences follow and are load-bearing elsewhere in this document.

Sugar must desugar back. `strings.__fabric_script` is what keeps the compiled form reversible: any persisted call can still be recognized as script-authored. Sugar that cannot be recovered is not sugar but a second module, and a second module would mean maintaining approval, audit, rendering, and lifecycle twice.

Sugar is normally transparent to review; this sugar is not. A `code` payload is parsed and type-checked, while a `script` payload is inspected by nothing. So the two are one path mechanically and divergent on exactly one axis — opacity — and every risk this feature carries sits on that axis. The enforce-mode rejection and the forfeited type check are both consequences of it, not independent policy choices.

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
- `script` may coexist with `display` and `resultFormat`, which still act on the outer call.
- `script` rejects `strings`, `tokenBudget`, and `agentBudget`. None of the three can reach a shell payload: `π` is a guest-side binding a shell script cannot read and Fabric performs no interpolation into the script, while both budgets are observed only by `workflow.agent()` calls, which a compiled script never makes. Passing one is not a harmless extra — it is evidence the caller wanted `code`, and accepting it silently would both waste transcript and teach the model that `π` works inside a script. Fabric's own reserved `strings.__fabric_script` is written by compilation, not by the caller.
- Fabric reserves `strings.__fabric_script`; a caller-provided collision fails before execution.
- Script mode returns the Bash text output as the outer Fabric value, except under `settle: true`, where it returns the outcome envelope described in Deterministic compilation.
- A script value is preserved exactly as received. Fabric performs no shell escaping, interpolation, rewriting, or normalization.

### Bash execution options

A `code` program reaches `pi.bash`'s option object directly; a bare compiled call would not. Two Bash behaviors are load-bearing often enough that script mode must carry them, because without them the script path is strictly weaker than the `code` path it is meant to replace:

- `settle` — `PiToolsProvider` throws on a failed nested tool result, so an ordinary nonzero exit (a failing test run, a `grep` with no match) would abort the Fabric call and discard the output instead of returning it as evidence. This is exactly the case the existing prompt guidelines answer with `settle: true`.
- `timeout` — Bash timeout is measured in seconds; a long suite otherwise has no way to raise the default other than retrying a timed-out call.

Both are exposed as flat, optional, script-only scalars:

- `timeout?: number` (seconds, minimum 1) and `settle?: boolean`.
- Both are rejected before execution when `script` is absent; they are not a second way to configure a `code` program, which already has the real option object.
- Both compile into the nested call's option object rather than into the script text.

`PiBashOptions` canonically carries exactly three settings — `timeout`, `settle`, and `cwd` — with the remaining spellings being runtime-repaired aliases of those. Script mode therefore reaches two of three here, and the third is deferred rather than refused: per-call `cwd` ships on its own branch and is a follow-up once that change lands upstream, at which point script mode is at full option parity with `pi.bash`.

The interim `cwd` gap is also the least load-bearing of the three, because a shell program can root itself: `cd <path> || exit 1` as the script's first line does what the option does. That is not true of `timeout` or `settle`, which no amount of script text can reproduce — which is why those two could not wait.

Any option outside those three does not exist. A payload needing something else is a `code` payload.

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
  "script": "<payload>"
}
```

to the existing internal representation:

```json
{
  "code": "const result = await pi.bash(π.__fabric_script); return result.output;",
  "strings": {
    "__fabric_script": "<payload>"
  }
}
```

The compiled `strings` holds the reserved key and nothing else, because the
contract rejects a caller-supplied `strings` alongside `script`.

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
  "code": "const result = await pi.bash(π.__fabric_script, { timeout: 600, settle: true }); return result.ok ? { ok: true, exitCode: 0, output: result.output } : { ok: false, exitCode: result.exitCode, output: result.output };",
  "strings": { "__fabric_script": "<payload>" }
}
```

The return projection differs by option because the nested envelope does. A default or `timeout`-only call resolves to `{ ok: true, output, details }` and returns bare `result.output`. A `settle: true` call resolves to `{ ok: false, output, details, exitCode, error }` on an ordinary nonzero exit, so it must return the outcome alongside the text: returning `result.output` there would hand back the output while discarding the exit status that is the entire reason to pass `settle`, leaving the model to infer pass/fail by reading the text.

The settle template branches on `result.ok` rather than reading `result.exitCode ?? 0` directly, because `pi.bash` returns a discriminated union whose `ok: true` member carries no `exitCode`. Fabric's own type gate would not catch the flat form — it filters type-correctness diagnostics, `TS2339` among them, and rejects on syntax — so this is written to be correct under an ordinary `tsc`, and stays correct if that filter is ever tightened.

Emit only the options the caller actually supplied, so the default case stays byte-for-byte identical to the bare compiled program above. The compiled program is a fixed template selected by which options are present — never string-built from caller values, which stay in the option object as typed scalars.

One projection loss is accepted and must be documented rather than worked around: neither template returns `details`, so a script cannot read structured truncation metadata the way a `code` program can. The truncation notice remains in the output text, and a payload that needs the structured form is a `code` payload.

Compilation must be idempotent. A second preparation pass sees canonical `code + strings` and leaves the object unchanged.

`strings.__fabric_script` is the authoritative marker for "this call was authored as a script". Everything downstream of preparation — mode gates, rendering, title hints — detects script mode by that key, not by an outer `script` argument, which no longer exists after preparation.

## What script mode gives up

The type check is the one Fabric guarantee this feature deliberately forfeits, and the spec is not honest without saying so. A `code` payload is parsed and type-checked before it runs; that is what produces the static rejections this change is trying to remove. A `script` payload is never inspected at all. The compiled program around it type-checks trivially and always passes, so a malformed shell program reaches the sandbox and fails at runtime instead of being rejected before it starts.

That is the trade the whole feature makes: fewer static rejections caused by TypeScript string escaping, in exchange for no pre-execution validation of the payload. `set -eu` and correct quoting become the model's own responsibility. The Fabric-side affordances built on the type checker do not apply either — no type-error recovery hint, and none of the guest-type near-miss argument repairs, which operate on a parsed call the script does not have.

The consequence for measurement is direct: a drop in static rejections is not by itself a win if the same payloads now fail at runtime instead. The dogfood protocol must watch both sides of that ledger, or the feature will look successful while having only moved failures between buckets.

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

- Script compilation, reserved-key collision, `code + script` conflict, rejection of `strings`/`tokenBudget`/`agentBudget` alongside `script`, malformed values, and idempotency are all covered by red-then-green tests.
- `strings` passed with `code` keeps its current identity/no-copy behavior; only the `script` pairing is rejected.
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
- A `settle: true` script returns a nonzero-exit result as an outer value instead of aborting the Fabric call, and that value carries the exit status, not the output text alone; without `settle`, the same script fails the way any failed nested `pi.bash` fails today.
- A `timeout` script reaches the host with seconds, not milliseconds.
- No script payload is duplicated into durable trace-safe error fields.

### Step 6: Validate and prepare dogfood

Run the repository's typecheck, build assertions, lazy-graph assertion, full tests, and dead-code check. Update user-facing configuration/interface documentation only after behavior is stable.

Completion criteria:

- All repository checks pass with no skipped regression test.
- A deterministic CLI probe executes a script containing quotes, `${HOME}`, backticks, heredoc syntax, command substitution, and sed backreferences without embedding it in TypeScript.
- A second probe covers the option path end to end: a deliberately nonzero-exit script with `settle: true` returns its output *and* its exit code, and a raised `timeout` is honored.
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
- runtime shell failures per script call, split into script-authoring faults (syntax, quoting, unset variable) and genuine command failures — the counter-metric for the forfeited type check
- retries after a runtime script failure, compared against retries after a static rejection
- calls, processed tokens, and elapsed time where available
- script selections on tasks that later require multi-tool code orchestration

Establish the baseline before fixing any numeric gate. A matched baseline has been recorded from sessions started 2026-08-19 through the build switch, under the same instrument and the same definitions the script-mode window will use:

| Baseline metric | Value |
| --- | ---: |
| Bash-related calls | 4,511 |
| Bash syntax failures per Bash call | 0.0086 |
| Runtime authoring faults per Bash call | 0.0144 |
| **Combined authoring failures per Bash call** | **0.0231** |
| Mean calls to recover after a static rejection | 1.15 |
| Mean calls to recover after a runtime shell failure | 1.07 |

The pre-registered gate is that the combined figure falls below 0.0231. Recording a matched baseline is a completion requirement; hitting a particular number is not.

Two measurement rules the instrument had to learn the hard way, both of which silently produced plausible wrong numbers first. Deduplicate globally by `toolCallId` and by record id: resumed and branched sessions replay earlier tool calls and assistant turns, which inflates call counts and makes token totals quadratic. And select windows by **session start**, not by record timestamp: Pi binds the extension build when a session starts, so a session running across the switch keeps the old build to its end, and time-filtering counts its calls against the new build — reading 0% script selection for calls that could not have selected `script`.

Two gates are unconditional, because they are correctness rather than adoption:

- no script-caused approval, audit, cancellation, timeout, or rendering regression
- no material increase in total tool calls; investigate token growth above 10%
- no net transfer of failures from static rejection to runtime script fault: the two counts are read together, and a reduction in the first that is matched by a rise in the second is a null result, not a win

The adoption targets below are starting hypotheses, not gates, and no measurement backs them yet. Replace them with baseline-derived numbers before the window closes. Missing one is a signal to investigate — a discoverability problem, a mode boundary, a wrong default — not by itself a reason to abandon the feature:

- around 60% natural script selection on eligible one-script tasks
- a substantial reduction in Bash syntax failures against the matched baseline, provisionally half

Size the second one against what the replay found: `script` owns 26 of 145 static rejections. Halving the Bash syntax rate is plausible only if script selection is high on exactly the payloads that produce it; a miss is more likely to be a selection-rate finding than a failure of the mechanism, which cannot produce this class of rejection at all.

Report every metric as measured, including the ones that moved the wrong way, and state which gate was pre-registered and which was set after seeing the baseline.

Rollback by restoring the prior local package path. Do not remove or alter the independent cwd dogfood build when isolating a script-mode regression.

## Non-goals

Each entry below is the design stance applied, not an independent judgment call. Reopening one means arguing that `script` is something other than sugar over `code`.

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
