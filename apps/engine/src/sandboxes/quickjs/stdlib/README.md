# sk-Stdlib — Contributor Guide

This directory owns the curated helper surface that is injected into every
QuickJS sandbox context before user code runs. Any function available as
`sk.*` inside a before-request hook or `language: "javascript"` transform
comes from `stdlib.js` in this directory.

## Why it exists

The sandbox guarantees zero host globals (no `fetch`, no `process`, no
`require`, no `Date.now` leak). That isolation is strong but forces user
code to re-implement routine helpers (null-safe access, HTTP-method
classification, decision shapes). The stdlib gives operators a vetted
surface so their code stays short, reviewable, and uniform across tenants.

The LLM-authoring layer proposes `sk.*` calls by default (see
`conversations/seed/skills/workflow-authoring.md`) — if you change this
surface, also update that skill so proposals stay consistent.

Encoding helpers carry migration-sensitive semantics. `base64Encode` and
`base64UrlEncode` intentionally match JSONata `$base64encode` low-8-bit
binary-string behavior so JSONata-to-JavaScript migrations can prove
byte-identical output. Use `base64EncodeUtf8` and `base64UrlEncodeUtf8`
for new Unicode text payloads. The inverse decoders (`base64Decode`,
`base64DecodeUtf8`) and the Web `btoa` / `atob` globals are installed too,
so author code never hand-rolls a codec.

As of **v1.4.0** the surface also includes:

- `hexEncode` / `hexDecode` — lowercase-hex codec (same byte convention as
  `base64Encode`).
- `sha256(input)` / `hmacSha256(key, msg)` — pure FIPS-180-4 SHA-256 and
  HMAC-SHA-256 over the UTF-8 bytes, returning lowercase hex. No host
  crypto, no `Buffer`, no `crypto.subtle` — implemented in-sandbox so a
  signed-payload transform reproduces byte-for-byte under self-healing
  dry-runs.
- `now()` / `nowIso()` — the execution's **fixed** timestamp (epoch ms /
  ISO string). The host injects it via `RunJsOptions.clock`; every call in
  a run sees the same instant.
- `uuid()` — a deterministic UUIDv4-shaped id derived from the injected
  per-execution seed plus a per-context call counter. Distinct on each
  call within a run, identical across replays.

These let authors stop hand-rolling encoders and stop reaching for the
banned `new Date()` / `Date.now()` / `Math.random()`.

As of **v1.5.0** the surface adds the MIME layer:

- `mimeEncodeHeaderValue(value)` — RFC 2047 encoded-word(s) for non-ASCII
  header values (`=?UTF-8?B?…?=`, folded at the 75-char limit). Email
  headers are ASCII-only by RFC 5322; a raw non-ASCII Subject gets
  Latin-1-mangled by the receiving server ("–" → "Ã¢Â€Â“").
- `buildMimeMessage({ from, to, subject, html?, text?, … })` — a complete
  RFC822 message plus its base64url form (the Gmail `raw` field). Headers
  RFC-2047-encoded, bodies base64 with UTF-8 charset, html+text as
  multipart/alternative, deterministic content-derived boundary. Author
  code should never hand-assemble MIME.

## Layout

| File                 | Role                                                                 |
|----------------------|----------------------------------------------------------------------|
| `stdlib.js`          | Plain ES2020 source — evaluated inside QuickJS on every sandbox call |
| `stdlib.d.ts`        | TypeScript types — consumed by authoring tooling, not at runtime     |
| `index.ts`           | Reads `stdlib.js` at load time; exports `STDLIB_SOURCE`, `STDLIB_VERSION` |
| `drift.ts`           | Pure helper that detects major-version drift vs. recorded workflows  |
| `tests/*.test.ts`    | Unit tests — run inside QuickJS via `runJs`, not in Node             |

## Versioning

The stdlib is semver-versioned. The version lives in **two places** that
must stay in sync:

1. `stdlib.js` — the `version: "X.Y.Z"` literal on the frozen `sk` object.
2. Automatically parsed by `index.ts` into `STDLIB_VERSION`.

Nothing else records a version — do not add a second source of truth.

### When to bump

| Change                                                               | Bump  |
|----------------------------------------------------------------------|-------|
| Add a new function or a new read-only field                          | Minor |
| Fix a bug that keeps the existing contract                           | Patch |
| Change a signature, remove a function, change observable behaviour   | Major |
| Internal refactor with no surface change                             | Patch |

A **major bump** must be paired with a documented migration path so the
self-healing loop can propose a Patch Candidate when it encounters a
workflow persisted against the previous major. See `drift.ts` for the
detection side.

## Adding a function

1. Implement it in `stdlib.js` (plain ES2020, no `Date.now`, no
   `Math.random`, no host globals).
2. Add the typed signature to `stdlib.d.ts`.
3. Add unit tests under `tests/` — tests run inside the QuickJS sandbox
   via `runJs`, so they exercise the same evaluator path user code sees.
4. Bump `version` in `stdlib.js` (minor for additive, major otherwise).
5. Update `conversations/seed/skills/workflow-authoring.md` and
   `mcp-tool-contract.md` so the LLM-authoring layer proposes the new
   call.
6. Run `/verify`.

## Determinism

The stdlib must remain deterministic. No `Date.now`, no `Math.random`, no
host I/O, no async. Self-healing dry-runs depend on sandbox execution
being reproducible; any non-determinism here leaks into the whole
governance pipeline.

`now()`, `nowIso()`, and `uuid()` are deterministic *by construction*:
they do not read a live clock or RNG. The host injects a fixed per-run
timestamp and seed through `RunJsOptions.clock` (`__sandbox_now__` /
`__sandbox_seed__`), and the stdlib derives every value from those. A run
replayed with the same execution context yields byte-identical output.

There is intentionally **no** unseeded `now()` or `uuid()`, and there are
**no** `crypto.subtle`, `Buffer`, or host-clock primitives — the sandbox
injects only `input` plus the fixed `clock` context, so a non-deterministic
clock/seed source simply does not exist inside the VM. If you ever need a
new ambient value, inject it from the host execution context the same way
`clock` is injected; never read it from inside the stdlib.

## Size budget

The stdlib source is evaluated afresh on every `runJs` call (QuickJS does
not share bytecode across contexts). Current size is ~26 KB — the SHA-256
implementation and the MIME layer dominate. A size tripwire
(`tests/size.test.ts`) fails the build if the source crosses **30 KB**.

The ceiling was consciously raised from 25 KB for the MIME surface: `sk`
is frozen at install time, so a lazily injected sub-module cannot attach
to it — an on-demand loader would mean unfreezing the surface or a second
global, both worse than the marginal extra parse per invocation. The next
additive surface past 30 KB must revisit that trade-off rather than bump
the number again.
