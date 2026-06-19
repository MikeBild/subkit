# QuickJS sandbox — capabilities & limits

All **user-authored JavaScript** in the engine runs inside a **QuickJS engine
compiled to WebAssembly** (`@jitl/quickjs-singlefile-cjs-release-sync`, the
**sync** variant). This is the engine's isolation boundary for untrusted JS — it
is *not* a general execution substrate. Connectors and the rest of the engine are
native TypeScript; only these five JS surfaces touch QuickJS:

| Surface | Entry | Limit tier |
|---|---|---|
| `transform` steps (`language: "javascript"`) | `execution/steps/transform.ts` | `sandbox.transform_wall_ms` (60 s) + general defaults |
| before-request hooks | `auth/hooks.ts` | `HOOK_LIMITS` — fixed 32 MB / 100k ticks / 2 s |
| hook lint | `auth/hooks.ts` | fixed 16 MB / 50k ticks / 1 s |
| `for_each` / loop selectors | `execution/steps/loop.ts`, `execution/loop-scope.ts` | 5 s wall + general defaults |
| `validation_function` / `output_transform_function` | `execution/engine.ts` | general defaults (incl. `wall_ms` 30 s) |

The single-file variant inlines the WASM as base64 so it survives
`bun build --compile`; the default `getQuickJS()` would load a separate `.wasm` the
compiled binary can't find. A boot smoke test fails the release if this regresses.

## What QuickJS can do

- **ES2023-complete**: modules, async generators, proxies, BigInt, TypedArrays,
  full Unicode regex. Passes ~100 % of test262 for ES2023.
- Deterministic, no host globals: `fetch`, `process`, `require`, `Bun` are all
  `undefined`. The only injected surface is the frozen `sk` stdlib
  (`stdlib/index.ts`: `sk.get`, `sk.http`, `sk.pick`, `sk.groupBy`, …).
- Input/output cross the boundary as JSON (`JSON.stringify` host→VM, parse back).

## What it cannot do — design limits

- **No `Intl` / ECMA-402.** No locale-aware formatting, collation, or number/date
  formatting. Do this in a request step or upstream.
- **No async, no I/O.** The sync variant has no event loop: no `await`, no
  Promises that need to settle against a host, no async host calls. Transforms are
  pure functions of their input — to fetch data, use a `request`/`call` step.
- **Slow.** QuickJS is an interpreter: ~2–3× slower than the V8 interpreter,
  20–100× slower than V8's JIT. Fine for reshaping JSON; wrong tool for heavy
  compute (crypto, large-matrix math, parsing megabytes of text in a loop).
- **Synchronous execution blocks the worker.** A QuickJS `evalCode` runs to
  completion synchronously inside the WASM module — it holds the Bun/Node event
  loop on that worker for the *entire* call. A 60 s transform = 60 s of blocked
  worker. This is why `transform_wall_ms` is short and why the answer to "my
  transform is slow" is **chunk it**, never "raise the timeout".

## The four limits — what each one actually enforces

Defaults live in engine config under `sandbox.*` (schema:
`config/schema.ts`); the static fallback used before config loads is
`DEFAULT_LIMITS` in `types.ts`. Per-call `limits` overrides win over both.

| Limit | Default | Enforced by | What it really means |
|---|---|---|---|
| `memory_bytes` | 128 MB | `runtime.setMemoryLimit` | Hard WASM heap cap. **The binding constraint for data-heavy transforms** — input exists twice (host JSON string + parsed VM objects), so a ~30 MB input can balloon past 128 MB. |
| `wall_ms` | 30 s (transforms: 60 s) | `Date.now()` check in the interrupt handler | **The real runaway guard.** The only limit that reliably stops compute-heavy or tight-loop code. |
| `tick_budget` | 10 M | `setInterruptHandler` tick count | A **coarse backstop, NOT an opcode count.** QuickJS fires the handler on an internal counter (`JS_INTERRUPT_COUNTER_INIT = 10000`) at loop back-edges and function calls — *not per opcode*. Tight inner loops can elide it entirely, so it can't be relied on to bound CPU; that's the wall-clock's job. Floored at `MIN_TICK_CAP = 2000`. |
| `stack_bytes` | 2 MB | `runtime.setMaxStackSize` | Recursion depth ceiling (~a few thousand frames). Deep recursive descent over deeply-nested JSON can hit it; iterate instead, or raise per-call. |

### Why `tick_budget` is not an opcode budget

The interpreter only polls the interrupt handler at backward jumps and calls. A
straight-line or tight numeric loop may run millions of opcodes between polls (or
never poll), so a nominal "10 M opcode" budget translates to no usable instruction
bound. Treat `tick_budget` as a loose "this has clearly run away" tripwire and rely
on `wall_ms` + `memory_bytes` for real enforcement. `tick-calibration.test.ts`
pins the qualitative behavior (ticks scale with work; realistic workloads stay well
under the default).

## Guidance for complex workflows

- **Memory, not CPU, is usually the ceiling.** For large datasets, prefer
  streaming/paginated `request` steps and `for_each` chunking over one transform
  that materializes everything. Raise `sandbox.memory_bytes` only as a last resort.
- **Keep transforms short and synchronous-cheap.** They block a worker. Long or
  heavy logic belongs in multiple steps, not one big transform.
- **No `await` in a transform.** If you need external data mid-transform, that's a
  workflow-shape problem — add a step.
- **Tune via config, not code.** `sandbox.memory_bytes`, `sandbox.wall_ms`,
  `sandbox.tick_budget`, `sandbox.stack_bytes`, `sandbox.transform_wall_ms` are all
  operator-tunable (`sk settings set sandbox.<key> …`). Hook tiers stay fixed for
  security and do not track these.

## Lifecycle notes

The WASM module is a lazy singleton (instantiated once, ~hundreds of ms). Each
`runJs` call creates a **fresh runtime + context** (not pooled) and disposes them
in a `finally`. There is **no host-eval fallback** — if QuickJS fails to load,
`runJs` throws (fail-closed); see `fail-closed.test.ts`.
