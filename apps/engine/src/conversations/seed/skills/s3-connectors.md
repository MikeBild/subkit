---
slug: s3-connectors
scope: global
title: S3 And MinIO Connectors
description: Driver specifics for the S3-compatible object store — put, get, list, and multipart behavior.
gates_tools: []
version: 1
---

# S3 And MinIO Connectors

The `s3` driver talks to any S3-compatible object store: AWS S3, MinIO,
Cloudflare R2, DigitalOcean Spaces. Same config shape, same step shape.

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

## Operations

### `put` — upload an object

```json
{
  "id": "archive_report",
  "kind": "request",
  "config": {
    "connector": "reports_store",
    "method": "put",
    "key": "weekly/${input.week}/sales.json",
    "body": "${scope.render.data}",
    "content_type": "application/json",
    "metadata": { "tenant": "${input.tenant_id}" }
  }
}
```

`body` can be a string, a JSON object (auto-stringified if `content_type` is
`application/json`), or a base64-encoded binary blob if `body_encoding: "base64"`.

Envelope: `data` is `{ "key": "...", "etag": "...", "version_id": "..." }`.

### `get` — download an object

```json
{
  "id": "load_manifest",
  "kind": "request",
  "config": {
    "connector": "reports_store",
    "method": "get",
    "key": "manifests/${input.manifest_id}.json",
    "parse_as": "json"
  }
}
```

`parse_as` is one of `"json"`, `"text"`, `"base64"`. If omitted, the driver
inspects `content-type` and falls back to `text`. `data` is the parsed body.

### `list` — list objects under a prefix

```json
{
  "id": "list_today",
  "kind": "request",
  "config": {
    "connector": "reports_store",
    "method": "list",
    "prefix": "daily/${input.date}/",
    "max_keys": 1000
  }
}
```

Envelope: `data` is an array of `{ "key", "size", "last_modified", "etag" }`.
The driver auto-paginates via continuation tokens up to `max_keys` items.

## Multipart upload

For `put`, the driver switches to multipart upload when `body` size exceeds
**8 MiB**. This is transparent — you don't configure it. Below 8 MiB, a
single PUT is used.

Implications:

- Transient network failures during multipart upload abort the upload; the
  driver cleans up the incomplete parts before returning.
- Retrying a failed multipart `put` is safe: the same key overwrites, and no
  orphaned parts remain.
- If you're uploading gigabyte-scale blobs, expect `duration_ms` in the tens
  of seconds. Consider `onError: { mode: "retry", max_retries: 2 }`.

## Key conventions

S3 has no real directories, but clients lean on prefix conventions:

- **No leading slash.** `reports/2026/april.json`, not `/reports/2026/april.json`.
- **Trailing slash for "directories".** `reports/2026/` is a prefix; listing
  it returns everything beneath.
- **Stable, predictable keys.** `tenants/${input.tenant_id}/runs/${input.run_id}/output.json`
  is better than `${$uuid()}.json` because it's idempotent — re-running the
  workflow overwrites in place instead of accumulating orphans.
- **Lowercase, hyphens over underscores.** Many CDNs and tools choke on
  uppercase or spaces in keys.

## Example: write + read round-trip

```json
{
  "steps": [
    {
      "id": "build_payload",
      "kind": "transform",
      "config": { "expression": "{ 'generated_at': $now(), 'rows': $scope.query.data }" }
    },
    {
      "id": "archive",
      "kind": "request",
      "config": {
        "connector": "reports_store",
        "method": "put",
        "key": "runs/${input.run_id}/result.json",
        "body": "$scope.build_payload.data",
        "content_type": "application/json"
      }
    },
    {
      "id": "verify",
      "kind": "request",
      "config": {
        "connector": "reports_store",
        "method": "get",
        "key": "${scope.archive.data.key}",
        "parse_as": "json"
      }
    }
  ]
}
```

## Common pitfalls

- **Leading `/` in keys.** Some backends (MinIO) accept it but AWS stores it
  literally, creating a key named `/reports/...`. Always strip.
- **Forgetting `content_type` on `put`.** Without it, downstream consumers
  (browsers, CDNs) get `application/octet-stream` and mis-render.
- **Huge `list` with no `prefix`.** Listing an entire bucket with millions of
  objects times out and blows the scope. Always scope with `prefix`.
- **Reading secrets from keys.** Object keys appear in access logs. Never put
  credentials, tokens, or PII in the key itself — keep those in the body.
- **Assuming strong consistency across regions.** Writes to one region
  aren't immediately readable from another. If your workflow does
  put-then-get-in-the-same-region, you're fine; cross-region, you'll need
  retry with backoff.

## See also

- `subkit-concepts.md` — envelope fields.
- `http-connectors.md` — if your object store exposes presigned URLs, you can
  use the `http` driver for cross-cutting reads.
- `error-recovery.md` — `http_5xx` and `step_timeout` handling.
