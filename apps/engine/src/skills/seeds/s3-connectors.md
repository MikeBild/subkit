---
slug: s3-connectors
scope: global
title: S3 And MinIO Connectors
description: Driver specifics for the S3-compatible object store — put, get, list, head, delete, plus content_type / metadata / parse_as.
activates_when: [{"kind":"connector_driver","driver":"s3"}]
side_effects: write
idempotency: naturally
maturity: stable
tags: [driver, s3, object-store]
version: 9
---

# S3 And MinIO Connectors

The `s3` driver talks to any S3-compatible object store: AWS S3, MinIO,
Cloudflare R2, DigitalOcean Spaces. Same connector config, same step shape.

## Recurring report permission

When a workflow's automation review reports `dynamic_request` or `destructive_effect` on a step that uses the s3 driver, the supported remedy is exactly one thing: author `s3.scope` on that step. Nothing else removes those two codes for a storage step. `max_keys` and `paginate` are derived by the engine from the step itself — they can never be set or templated per prefix.

A supported bounded storage proposal lives at `steps[index].s3.scope`, with `key_prefix` (a fixed narrow existing folder ending `/`), `max_bytes` (positive integer, at most 10000000, enforced for PUT), and optionally `max_deletes` (positive integer, at most 10000) when the step removes objects. There is no `path_prefix` field and no `config` wrapper on a request step. Use `edit_workflow_patch` with `step_patches: [{step_id, op: "add", path: "/s3/scope", value: {key_prefix, max_bytes}}]` to set the scope on each inspected top-level step. The server resolves IDs against the current draft. Never guess numeric indices or overwrite the full S3 configuration.

Keep the full existing folder including namespace segments. GET, HEAD, LIST and PUT can use this proposal; DELETE can only when `max_deletes` is also set. Be precise about what that ceiling is: it is a reviewed number shown to the human, and every single call is checked to stay inside the reviewed folder and to carry no body, but nothing counts removals across one run yet — a loop still issues one bounded removal per item. Never present it as a machine-enforced total. A removal step whose folder would have to widen to cover everything it touches should be split into narrower per-folder steps instead. LIST additionally binds fixed `max_keys` and `paginate`. Recurring scope does not support metadata, range, presign or multipart options. This is draft preparation only: after validation and held-write preview, the human reviews folders, replacement effects and finite run limits through `review_workflow_automation` in the same chat. Do not claim permission exists until schedule automation is authorized. Explain report folders and outcomes to the user, not JSON fields or patch instructions.

## Connector config paths

A `s3` connector stores the following in its config:

```
${connector.<slug>.config.bucket}    // e.g. "reports-prod"
${connector.<slug>.config.region}    // e.g. "eu-central-1"
${connector.<slug>.config.endpoint}  // optional, for MinIO/R2
${connector.<slug>.config.force_path_style}  // true for MinIO
```

Credentials: `${cred.<slug>.access_key_id}` and `${cred.<slug>.secret_access_key}`.
The driver wires these automatically — you don't pass them in step configs.

## Step shape

A request step with `"protocol": "s3"` carries the structured `s3` block,
which expresses every supported operation. `key` (object path) and `prefix` (LIST scope) accept `${input.…}`
and `${scope.<id>.…}` placeholders.

## Operations

### PUT — upload an object

```json
{
  "id": "archive_report",
  "kind": "request",
  "protocol": "s3",
  "method": "PUT",
  "connector_id": "<reports_store_connector_id>",
  "s3": {
    "key": "weekly/${input.week}/sales.json",
    "content_type": "application/json",
    "metadata": { "tenant": "${input.tenant_id}" }
  },
  "body": "${scope.render.data}"
}
```

`body` is the object payload — string for text/JSON, base64-encoded string
for binary. Envelope: `data` is `{ "key": "...", "etag": "...", "version_id": "..." }`.

### GET — download an object

```json
{
  "id": "load_manifest",
  "kind": "request",
  "protocol": "s3",
  "method": "GET",
  "connector_id": "<reports_store_connector_id>",
  "s3": {
    "key": "manifests/${input.manifest_id}.json",
    "parse_as": "json"
  }
}
```

`parse_as` is one of `"json"`, `"text"`, `"base64"`, `"bytes"`. Default
returns the body as the driver delivered it (string for text content types,
Buffer for binary). On `"json"`, the driver parses and surfaces an
object/array; on `"text"` you get a UTF-8 decoded string; on `"base64"` the
raw bytes are base64-encoded (lossless for binary payloads); on `"bytes"`
the step output is a Node `Buffer` — use this when piping to a downstream
binary consumer or when you want byte-exact integrity.

### LIST — list objects under a prefix

```json
{
  "id": "list_today",
  "kind": "request",
  "protocol": "s3",
  "method": "LIST",
  "connector_id": "<reports_store_connector_id>",
  "s3": {
    "prefix": "daily/${input.date}/",
    "max_keys": 1000
  }
}
```

Envelope: `data` is `{ "items": [...], "count": N, "truncated": false }`.
Each entry: `{ "key", "size", "etag", "last_modified" }`. The driver caps
at `max_keys` (default 1000, hard limit 10 000). If `truncated: true`, refine
the prefix or page externally.

### HEAD — object metadata only

```json
{
  "id": "verify_archive",
  "kind": "request",
  "protocol": "s3",
  "method": "HEAD",
  "connector_id": "<reports_store_connector_id>",
  "s3": {
    "key": "weekly/${input.week}/sales.json"
  }
}
```

Returns `status_code: 200` with `data: { key, size, etag }` when present;
`404` when missing — branch on the status to handle the absent case.

### Asserting status codes

Set `expected_statuses` on an S3 step the same way you would on an HTTP step.
The dispatch maps S3 outcomes to synthetic status codes (`200` PUT/GET/HEAD,
`204` DELETE, `404` HEAD-on-missing) so the assertion reads the same:

```json
{
  "id": "guard_present",
  "kind": "request",
  "protocol": "s3",
  "method": "HEAD",
  "connector_id": "<reports_store_connector_id>",
  "s3": { "key": "weekly/${input.week}/sales.json" },
  "expected_statuses": [200]
}
```

Mismatch surfaces typed `unexpected_status_code` — the run fails before
downstream steps consume `data`.

### DELETE — remove an object

```json
{
  "id": "purge_old_export",
  "kind": "request",
  "protocol": "s3",
  "method": "DELETE",
  "connector_id": "<reports_store_connector_id>",
  "s3": {
    "key": "exports/${input.expired_id}.json",
    "scope": { "key_prefix": "exports/", "max_bytes": 10, "max_deletes": 500 }
  }
}
```

## Key conventions

S3 has no real directories, but clients lean on prefix conventions:

- **No leading slash.** `reports/2026/april.json`, not `/reports/2026/april.json`.
  The driver strips a leading `/` if you accidentally include one.
- **Trailing slash for "directories".** `reports/2026/` is a prefix; LIST
  with that prefix returns everything beneath.
- **Stable, predictable keys.** `tenants/${input.tenant_id}/runs/${input.run_id}/output.json`
  is better than `${$uuid()}.json` because it's idempotent — re-running the
  workflow overwrites in place instead of accumulating orphans.
- **Lowercase, hyphens over underscores.** Many CDNs and tools choke on
  uppercase or spaces in keys.

## Example: write + read round-trip

```json
{
  "name": "Daily report archive",
  "slug": "daily-report-archive",
  "steps": [
    {
      "id": "build_payload",
      "kind": "transform",
      "language": "javascript",
      "expression": "return { generated_at: input.input.generated_at, rows: input.scope.query.data };"
    },
    {
      "id": "archive",
      "kind": "request",
      "protocol": "s3",
      "method": "PUT",
      "connector_id": "<reports_store_connector_id>",
      "s3": {
        "key": "runs/${input.run_id}/result.json",
        "content_type": "application/json"
      },
      "body": "${scope.build_payload.data}"
    },
    {
      "id": "verify",
      "kind": "request",
      "protocol": "s3",
      "method": "GET",
      "connector_id": "<reports_store_connector_id>",
      "s3": {
        "key": "${scope.archive.data.key}",
        "parse_as": "json"
      }
    }
  ]
}
```

## Multipart, range, presign

Three advanced PUT/GET affordances:

- `s3.multipart` — set to `false` to force a single-PUT regardless of body
  size; default behaviour switches to multipart upload above the
  driver's threshold.
- `s3.multipart_threshold_mb` — override the threshold (default 8 MiB).
  Useful when uploading large but inline-friendly objects.
- `s3.range` — RFC 7233 byte-range expression on GET (e.g. `"bytes=0-1023"`)
  for partial reads.
- `s3.presign: { expires_in_s }` — return a presigned URL for the
  operation instead of executing it. Supported on GET and PUT; the
  step output is `{ url, method, expires_at }`.

## Common pitfalls

- **Leading `/` in keys.** AWS stores it literally as a key named `/foo`. The
  driver normalises by stripping leading slashes; still, write keys without
  one.
- **Forgetting `content_type` on PUT.** Without it, downstream consumers
  (browsers, CDNs) get `application/octet-stream` and mis-render.
- **Huge LIST with no `prefix`.** Listing an entire bucket with millions of
  objects times out and blows scope. Always set a `prefix` and a sensible
  `max_keys`.
- **Reading secrets from keys.** Object keys appear in access logs. Never put
  credentials, tokens, or PII in the key itself — keep those in the body.
- **Cross-region consistency.** Writes to one region aren't immediately
  readable from another. Same-region put-then-get is strong; cross-region,
  retry with backoff or pin reads to the write region.

## See also

- `subkit-concepts.md` — envelope fields.
- `http-connectors.md` — if your object store exposes presigned URLs, you can
  use the `http` driver for cross-cutting reads.
- `error-recovery.md` — `s3_error` and `step_timeout` handling.

A step is held to the `s3.scope` it declares on every run, preview included. A key that is not under `key_prefix`, or content larger than `max_bytes`, fails the step with `request_outside_declared_boundary` and names the folder or both sizes; nothing is sent. Choose `key_prefix` from the keys the workflow actually builds (read the transform that produces them) and `max_bytes` from the largest content it can produce, not from one preview. When a preview reports this error, correct that one number or folder; never remove the scope and never widen it to the whole bucket.
