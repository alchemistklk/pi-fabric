# Structured shell-script payloads for `fabric_exec`

Status: proposed for implementation and local dogfood  
Delivery: a separate change from `pi.bash` per-call `cwd` and PR #71

## Objective

Add a flat, model-facing `script` input to `fabric_exec` for requests whose payload is one complete shell program. Fabric must carry the script out of TypeScript source text, compile it onto the existing `strings`/`π` path, and execute it through the existing QuickJS → `pi.bash` path.

The feature succeeds when large shell programs no longer require JSON → TypeScript-string → shell triple escaping, while ordinary Fabric programs continue to use `code`.

## Evidence

The local historical corpus contains 7,349 completed `fabric_exec` calls, 136 static failures, and 74 failures confirmed by the TypeScript parser as syntax failures. Raw source text identifies `pi.bash(` in 41 syntax failures; the recovery AST still recognizes the Bash call in 38 of them. This is about 30% of all static failures and 55% of syntax failures.

An anonymized paired evaluation modeled the observed distribution of heredocs, pipes, loops, command substitutions, sed/awk backreferences, embedded Python/Node programs, and payload sizes. Across 36 paired task runs:

| Metric | Baseline | Structured script |
| --- | ---: | ---: |
| Static failures | 9/36 | 2/36 |
| Completed validly scored tasks | 34/34 | 34/34 |
| Tool calls | 65 | 66 |
| Mean wall time | 22.44 s | 22.07 s |
| Processed tokens | 248,540 | 268,259 |

The candidate selected `script` in 26/36 runs. Those 26 runs had zero static failures. These are local, synthetic results rather than production proof; they justify engineering and dogfood, not a success claim for upstream users.

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

The model-facing schema stays flat:

```ts
{
  code?: string;
  script?: string;
  strings?: Record<string, string>;
  // existing scalar/optional fields
}
```

Do not introduce a nested call IR, generic batch format, or `oneOf` tree with duplicated object branches. The existing schema deliberately avoids high-entropy nested tool arguments.

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

Compilation must be idempotent. A second preparation pass sees canonical `code + strings` and leaves the object unchanged.

## Mode gates

After `state.ensure(context)` and before `state.execution.execute(...)`, reject script mode unless all conditions hold:

- `state.config.fullCodeMode === true`
- `state.config.schema.mode !== "enforce"`

Schema audit mode may execute the script under its existing audit behavior. Orchestration-only mode must direct the caller to native Pi tools. Schema enforce mode must direct protected mutations to the schema transaction path. Rejection occurs before QuickJS or any nested tool call starts.

The outer schema may remain stable across modes, but its `script` description must name the supported mode boundary. Do not silently fall back to native Bash.

## Rendering and observability

### Outer call

- Render a raw `script` call as Shell, not as user-authored TypeScript.
- Apply the existing bounded code-preview rules and terminal sanitization.
- Avoid rendering both the raw script and the compiled constant program.
- Partial streaming arguments must not throw when `code` is absent.

### Nested call

- The nested call remains `pi.bash` and receives the exact script as its command.
- Approval classification sees the real script, not only the constant compiled code.
- Lifecycle events, previews, audit records, and trace outcomes retain their existing Bash shapes.
- Timeout, cancellation, nonzero exit, output truncation, and `settle: true` behavior match `pi.bash(π.script)`.

### Persistence

- Persist the model-authored outer `script` argument using Pi's normal tool-call transcript behavior.
- Durable Fabric traces continue their existing safe projection and must not add a second payload copy.
- Compaction intent may use the declared display metadata; it must not infer a title from the constant compiled program when the raw script is available safely to the normal title-hint path.

## Implementation brief

Work from the latest upstream `main` on a dedicated branch. Do not base the implementation PR on PR #71; the two changes are logically independent.

### Step 1: Lock the argument contract

Update `src/fabric-exec-arguments.ts` and its focused tests.

Completion criteria:

- Script compilation, caller strings preservation, reserved-key collision, `code + script` conflict, malformed values, and idempotency are all covered by red-then-green tests.
- Existing compatibility cases retain their current identity/no-copy behavior.

### Step 2: Expose the flat schema

Update `src/fabric-exec-tool.ts` so `code` and `script` are optional at schema level and runtime preparation enforces the exclusive contract.

Completion criteria:

- A real Pi tool invocation accepts `{script}` before ordinary schema validation.
- `{code}`, root-string code shorthand, and code arrays retain current behavior.
- `{}`, `{code, script}`, and non-string `script` fail before execution with actionable errors.

### Step 3: Add mode gates

Gate the prepared script invocation using live Fabric state after bootstrap.

Completion criteria:

- Full-code/off and full-code/audit execute.
- Orchestration-only and schema-enforce reject before QuickJS and before nested lifecycle events.
- Reload or configuration changes cannot leave a stale authorization decision.

### Step 4: Render the authored surface

Render raw script calls through the existing Shell/code-preview components, including partial argument streaming and bounded expansion.

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
- No script payload is duplicated into durable trace-safe error fields.

### Step 6: Validate and prepare dogfood

Run the repository's typecheck, build assertions, lazy-graph assertion, full tests, and dead-code check. Update user-facing configuration/interface documentation only after behavior is stable.

Completion criteria:

- All repository checks pass with no skipped regression test.
- A deterministic CLI probe executes a script containing quotes, `${HOME}`, backticks, heredoc syntax, command substitution, and sed backreferences without embedding it in TypeScript.
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

Provisional acceptance gates:

- at least 60% natural script selection on eligible one-script tasks
- at least 50% reduction in Bash syntax failures against the matched baseline
- no script-caused approval, audit, cancellation, timeout, or rendering regression
- no material increase in total tool calls; investigate token growth above 10%

Rollback by restoring the prior local package path. Do not remove or alter the independent cwd dogfood build when isolating a script-mode regression.

## Non-goals

- Generic batch or structured multi-tool IR
- Automatic conversion based on payload length
- Host-side guessing of malformed TypeScript string boundaries
- `stdin` support or a temporary-file stdin emulation
- Native Bash exposure in full-code mode
- Edit/write payload modes; those remain `code + strings`
- `process`, `require`, Node compatibility, or executor replacement
- Changes to per-call `cwd`

## Definition of done

Implementation is complete only when the contract, mode gates, authored-surface rendering, approval/lifecycle parity, repository validation, dogfood instrumentation, rollback instructions, and user-facing documentation are all present. Local green tests alone are not upstream delivery or dogfood proof.
