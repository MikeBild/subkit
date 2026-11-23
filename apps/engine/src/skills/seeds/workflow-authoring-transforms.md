---
slug: workflow-authoring-transforms
scope: global
title: Workflow Transforms And The sk Stdlib
description: The JavaScript transform contract, typed JSON bodies and read-only POSTs, where to reshape data, `input_schema` vs `input_schema_sample`, and the deterministic `sk` stdlib in the sandbox.
activates_when: [{"kind":"step_kind","step_kinds":["transform"]},{"kind":"tool","tool":"dry_run_transform"},{"kind":"intent_keyword","word":"transform"},{"kind":"intent_keyword","word":"javascript"},{"kind":"intent_keyword","word":"jsonata"},{"kind":"intent_keyword","word":"base64"},{"kind":"intent_keyword","word":"mime"},{"kind":"intent_keyword","word":"stdlib"},{"kind":"intent_keyword","word":"hmac"},{"kind":"intent_keyword","word":"sha256"},{"kind":"intent_keyword","word":"input_schema"}]
side_effects: read
idempotency: none
maturity: stable
tags: [authoring, workflow, transform]
version: 1
---

# Workflow Transforms And The sk Stdlib

## Typed JSON bodies and read-only POSTs

Two general request-body rules worth getting right up front (the
`http-connectors` skill has the full treatment):

- **A whole-value placeholder leaf carries its native type.** A body field
  that is exactly `"${ref}"` — nothing around it — reaches the wire as the
  referenced value's real JSON type: a number stays a number, an array stays
  an array, an object stays an object. Wrap the placeholder in surrounding
  text (a mixed string like `"id-${ref}"`) and the value is stringified
  instead. This is what lets a dynamically-built array ship as a real JSON
  array — compute it in a transform, then reference it whole:

  ```json
  { "body": { "children": "${scope.build_blocks.data}" } }
  ```

  `build_blocks` returns an array, so the API receives
  `{"children": [ … ]}`, not a quoted string.

- **Mark read-only POSTs with `side_effects: "read"`.** Some search / query
  endpoints use `POST` but mutate nothing. The runtime classifies steps as
  write by HTTP method, so dry-run HOLDS them by default. Set
  `side_effects: "read"` on such a step so dry-run runs it live and the judge
  sees real data. Use it ONLY for endpoints that genuinely read; a `POST`
  that creates / updates / sends stays a write. `side_effects` is an existing
  step field — no new schema.

## Transforms — JavaScript first

Every new `transform` step defaults to `language: "javascript"`. The
execution contract (verified against the QuickJS runtime — this is exactly
how the engine runs it):

- The authored code is a **FUNCTION BODY** (not a module, not an arrow
  function). The engine wraps it as `(function (input) { <body> })` and
  invokes it once; the body must `return` its result (a trailing
  expression also works).
- Exactly ONE value is exposed: the `input` argument.
  - `input.scope.<step_id>.data` — the recorded output of each upstream
    step (every step output is uniformly enveloped; read through `.data`).
  - `input.input` — the workflow input.
- The sandbox is QuickJS WASM with zero host globals — no `fetch`, no
  `process`, no `require`, no network, no `Date.now`/`Math.random`
  nondeterminism. Values are JSON-marshalled in and out.

```json
{
  "id": "shape_projects",
  "kind": "transform",
  "language": "javascript",
  "expression": "const projects = input.scope.fetch_projects.data.projects; return projects.map(p => ({ id: p.id, name: p.name }));"
}
```

A curated `sk` stdlib global is pre-installed in the sandbox (see
"sk-Stdlib" below). `output_transform_function` is the JS form of the
workflow-level output transform (mutually exclusive with the JSONata
`output_transform`).

### JSONata is NOT a transform language

A `transform` step is JavaScript-ONLY. JSONata is not a valid transform
language — `language: "jsonata"` on a `transform` step is rejected by the
schema. JSONata survives only in `data_selector`,
`branch.when`, `output_transform`, and `${scope.x.data}` string
interpolation. When you write JSONata in one of THOSE slots, the
addressing contract is strict:

- Upstream steps: `$scope.<step_id>.data…` (bare `<step_id>.data` also
  resolves). Workflow input: `$input`.
- On a step with `for_each` the current item is **`$item` ONLY** (plus
  `$loop_index`). A
  bare item name (`project.name`) is rejected at authoring time with a
  `did_you_mean: "$item.name"` rewrite.

## Reshape locations

Three places to reshape data — pick the smallest one that fits:

- **Step-level `data_selector`** — trim a step's `.data` for downstream consumers (drop heavy fields).
- **`transform` step** — reshape across multiple upstream steps, or compute derived values. JavaScript by default (see "Transforms — JavaScript first").
- **`output_transform_function`** (JS, preferred for new workflows) or **`output_transform`** (JSONata, legacy) — workflow-level final payload the caller sees (hide internals). Both receive the workflow's FINAL value — the last step's `.data`, not the step scope: in `output_transform_function` the single `input` IS that value (there is no `input.scope` and no `input.input`); in `output_transform` it is the root value, with `$scope.<step_id>.data` and `$input` additionally bound. Pick exactly one — the schema rejects setting both. Same affordance pattern as `validation_expression` (JSONata) vs `validation_function` (JS).

See `data-handling.md` for full examples.

## `input_schema` vs `input_schema_sample`

- **`input_schema`** — JSON Schema, enforced at runtime. Use for stable contracts (another workflow, a known webhook).
- **`input_schema_sample`** — literal example payload, used by dry-run + LLM context. Not enforced.

## sk-Stdlib in the sandbox

`transform` steps with `language: "javascript"` and before-request hooks
run inside QuickJS with a curated `sk` global pre-installed. Frozen
surface, deterministic (no `Date.now`, no `Math.random`, no host I/O).
Available calls:

- `sk.http.isMutating(method)` / `sk.http.isSafe(method)` — method classification
- `sk.http.METHODS.READ` / `WRITE` — pre-baked method arrays
- `sk.get(obj, "a.b.c", fallback)` / `sk.has(obj, path)` — null-safe access
- `sk.allow()` / `sk.deny(reason)` — canonical hook decisions
- `sk.pick(obj, keys)` / `sk.omit(obj, keys)` — subset / exclusion
- `sk.pluck(arr, key)` / `sk.groupBy(arr, keyOrFn)` / `sk.uniq(arr)` — array reshapers
- `sk.base64Encode(input)` / `sk.base64UrlEncode(input)` — JSONata-compatible
  low-8-bit base64 helpers; use when migrating `$base64encode` transforms and
  preserving byte-identical output matters
- `sk.base64EncodeUtf8(input)` / `sk.base64UrlEncodeUtf8(input)` — UTF-8
  base64 helpers; prefer for new Unicode text payloads such as MIME/API bodies
- `sk.base64Decode(input)` / `sk.base64DecodeUtf8(input)` — inverse decoders
  (binary-string and UTF-8); tolerate url-safe alphabet and missing padding
- `btoa(input)` / `atob(input)` — Web-standard binary-string base64 globals
  (`btoa` throws on code points > 255 — use `sk.base64EncodeUtf8` for Unicode)
- `sk.hexEncode(input)` / `sk.hexDecode(input)` — lowercase-hex codec
- `sk.buildMimeMessage({ from, to, subject, html?, text?, cc?, bcc? })` —
  complete RFC822 email + its base64url form (`raw` for Gmail send). ALWAYS
  use this for email bodies: headers are ASCII-only per RFC 5322, and a raw
  non-ASCII Subject ("–", umlauts) gets Latin-1-mangled by the mail server.
  Never hand-assemble the MIME string
- `sk.mimeEncodeHeaderValue(value)` — RFC 2047 encoded-word for one header
  value, when custom header assembly is unavoidable
- `sk.emailBody(message)` — decoded `{ text, html }` bodies of an email
  message envelope; the vendor wire format is detected by shape (Gmail
  `messages.get?format=full` payload tree with base64url parts, or a
  pre-decoded `{ body: { contentType, content } }` object). ALWAYS use this
  to read email content — `snippet` is a truncated teaser, not the message;
  shipping it as the body is the "succeeded with garbage output" failure
- `sk.rfc3339Parts(dateTime)` — faithful `{ date, time, offset, wall }` split
  of an RFC 3339 date/date-time WITHOUT timezone conversion (the sandbox has
  no tz database). For calendar events, format via `wall` and pass the
  vendor's `dateTime` + separate `timeZone` field through UNTOUCHED — slicing
  the string drops the offset and silently shifts times
- `sk.documentToMarkdown(value)` — rich document structures to markdown,
  preserving annotations (bold/italic/code) and links; the vendor format is
  detected by shape (Notion `blocks.children.list` response, block array, or
  rich_text span array). Unknown block types degrade to their text content,
  never to `""`. Use this instead of hand-rolled block renderers, which
  silently drop annotations
- `sk.sha256(input)` — SHA-256 of `input` (UTF-8), lowercase hex
- `sk.hmacSha256(key, msg)` — HMAC-SHA-256, lowercase hex (signed-request auth)
- `sk.now()` / `sk.nowIso()` — the execution's fixed timestamp (epoch ms / ISO);
  use these instead of `Date.now()` / `new Date()`, which are not available
- `sk.uuid()` — deterministic per-step UUID; use instead of `Math.random()` ids
- `sk.isString / isNumber / isArray / isObject / isNil` — type guards
- `sk.version` — stdlib version (persisted for drift detection)

Prefer the stdlib over raw comparisons so hook + transform code stays uniform.

**Never hand-roll base64, hex, or crypto.** Do not paste a base64/base32/hex
alphabet string or build a reverse-lookup table inside a transform — use
`sk.base64Encode` / `sk.base64Decode` / `sk.hexEncode` / `sk.hexDecode` /
`sk.sha256` / `sk.hmacSha256`. A hand-rolled encoder is rejected by the
authoring gate, and a redacted alphabet literal has corrupted authored code
into a malformed payload in production. Likewise never reach for `new Date()`,
`Date.now()`, or `Math.random()` — they are absent by design; use `sk.now()`,
`sk.nowIso()`, and `sk.uuid()`.

- The gate detects the literal alphabet form (a base64/base32/hex sequence
  pasted as a string), not chained string concatenations or
  `String.fromCharCode` tricks — don't try to evade it, just call the
  `sk.base64*` / `sk.hex*` helpers.

## Transform pitfalls

- **Confusing `output_transform` with `data_selector`.** `output_transform` runs
  once, at the end. `data_selector` runs per step. Using `output_transform` to
  trim an early step wastes scope space for the whole run.
- **Chasing escaped quotes inside `output_transform` as a "bug".** A `\"` (or a
  stored DAG showing `\\\"`) inside a JSONata `output_transform` is the normal,
  valid JSON encoding of a quote — JSONata accepts it and the runtime evaluates it
  correctly. It is cosmetic, not a defect. Do **not** burn version bumps
  `edit_workflow_patch`-ing the escaping back and forth. Only re-author the
  transform when a dry-run actually reports wrong output or an
  `unresolved_identifier` / `placeholder_unresolved` warning.

- **Writing JSONata that assumes arrays.** `$scope.foo.data.items` when `items`
  is missing returns `undefined`, which then blows up downstream. Guard with
  `$scope.foo.data.items ? $scope.foo.data.items : []` (in JS:
  `input.scope.foo.data.items ?? []`).
- **Expecting `call` to inherit parent scope.** A called workflow starts with a
  fresh scope; it only sees what's passed through `config.input`.
