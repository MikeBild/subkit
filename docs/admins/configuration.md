# Configuring the engine

SubKit keeps its canonical non-fundamental runtime configuration in PostgreSQL. Every change
creates an immutable revision; the database always wins on later boots. `DATABASE_URL`,
`MASTER_KEY`, and the listen-host binding remain process bootstrap because they are needed
before the database snapshot can be reached. Cockpit, HTTP, MCP, and the `sk` CLI expose the
same saved revision, active revision, activation state, and audit history.

| You want                        | Surface                                                 |
| ------------------------------- | ------------------------------------------------------- |
| Browser administration          | Cockpit → **Settings** (`/cockpit/settings`)            |
| Interactive terminal form       | `sk settings configure`                                 |
| Scriptable HTTP                 | `GET /v1/settings`, `PATCH /v1/settings`                |
| Revision history and activation | `/v1/settings/revisions*`, `/v1/settings/activations/*` |
| Secret versions                 | `/v1/secrets*`                                          |
| AI/agent administration         | MCP `subkit_settings`, `subkit_update_setting`          |
| CLI automation                  | `sk settings list / get / set`                          |

The generated [settings reference](./settings-reference.md) lists every leaf's type, default,
scope, sensitivity, and restart requirement.

## The database role must carry the search path

The engine owns the `subkit` schema and pg-boss owns `pgboss`. Configure the database role
before the first boot:

```sql
ALTER ROLE <subkit_role> SET search_path = subkit, pg_catalog, public;
```

This role-level setting works through transaction-mode poolers. `public` remains in the path
because migrations use pgcrypto. The engine verifies the resolved schema and refuses to start
against an unsafe search path.

## Bootstrap, then database authority

Only process-start values live in environment variables:

| Variable                           | Required                 | Purpose                                                                                                                                          |
| ---------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MASTER_KEY`                       | yes                      | Product-isolated, 64-character hex AES-256-GCM key used to encrypt versioned secrets in PostgreSQL. Losing it makes those secrets unrecoverable. |
| `DATABASE_URL`                     | every process start      | Fundamental PostgreSQL connection used to find the canonical runtime revision; never runtime-editable.                                          |
| `NODE_ENV`                         | no                       | `development`, `test`, or `production`.                                                                                                          |
| `ENGINE_LISTEN_HOST`               | no                       | Process bind address.                                                                                                                            |
| `PORT`                             | revision 1 only          | Seeds `server.port` in an empty database.                                                                                                        |
| `SUBKIT_BOOTSTRAP_KEY`             | no                       | Optional one-time onboarding key. Once bootstrap completes it is invalid even if the binding remains present.                                    |
| `OBJECT_STORAGE_ENDPOINT`          | revision 1 only          | S3-compatible endpoint.                                                                                                                          |
| `OBJECT_STORAGE_REGION`            | revision 1 only          | SigV4 region.                                                                                                                                    |
| `OBJECT_STORAGE_BUCKET`            | revision 1 only          | Private product bucket.                                                                                                                          |
| `OBJECT_STORAGE_ACCESS_KEY_ID`     | revision 1 only          | S3 access-key id.                                                                                                                                |
| `OBJECT_STORAGE_SECRET_ACCESS_KEY` | revision 1 only          | S3 secret access key.                                                                                                                            |
| `OBJECT_STORAGE_SESSION_TOKEN`     | revision 1 only          | Optional temporary credential token.                                                                                                             |
| `OBJECT_STORAGE_PATH_STYLE`        | revision 1 only          | `true` for path-style endpoints such as Garage/Upraft.                                                                                           |

On an empty database, bootstrap bindings and schema defaults become revision 1. Secret-valued
runtime leaves are immediately encrypted as immutable secret versions and the revision stores
only `secret://<name>/<version>` references. `DATABASE_URL` is the deliberate exception: the
revision contains only the non-secret `bootstrap://DATABASE_URL` sentinel and the real DSN
remains the active process binding, so a DSN rotation cannot split the request pool from
queue/listener connections. On every later boot, revision-1 seed variables cannot override
saved PostgreSQL state. Rotate the DSN in the workload secret and restart replicas; settings
writes to `database.url` fail closed.

`OBJECT_STORAGE_FORCE_PATH_STYLE` remains accepted as a compatibility alias. Do not set both
path-style aliases to different values.

Historical runtime variables and `SK_OVERRIDE_*` are development/import compatibility only.
Production startup does not read `subkit.config.json` or `SUBKIT_CONFIG`. Use the one-shot
bridge for an existing file-based installation:

```bash
engine --bridge-stateless \
  --legacy-config=/etc/subkit/subkit.config.json \
  --legacy-files-dir=/var/lib/subkit/blobs
```

The bridge is rerunnable. It imports supported settings, creates the initial database revision
only when safe, streams legacy files and offloads into the configured object store, verifies
size and application SHA-256, switches PostgreSQL pointers transactionally, and writes audit
markers. It refuses to overwrite a different pre-existing runtime configuration.

## First-run lifecycle

`GET /v1/bootstrap/status` reports `pending`, `completed`, and `token_expired`. Complete the
one-time setup through Cockpit, `sk init`, or `POST /v1/bootstrap/complete`. The completion call
creates the first tenant and administrator and returns the administrator API key exactly once.
Subsequent completion attempts return `410 Gone`.

The legacy `/v1/setup` aliases remain available for compatible clients.

## Saved and active revisions

`GET /v1/settings` provides the human-oriented settings view. Each item's `meta` carries the
schema's `default` (absent for a bootstrap binding such as `database.url`, masked for a secret) and,
for an enum, its `enum_values`; the MCP tool `subkit_settings` reports the same fields. The
canonical state endpoint is
`GET /v1/settings/runtime`; it reports:

```json
{
  "saved_revision": 12,
  "active_revision": 11,
  "activation_status": "saved",
  "pending_restart_fields": [],
  "settings": {}
}
```

Save a compare-and-swap revision with:

```http
PATCH /v1/settings
Content-Type: application/json

{
  "expected_revision": 11,
  "changes": {
    "log.level": "debug",
    "llm.model": "claude-sonnet-4-6"
  },
  "scope": "global"
}
```

Use `scope: "tenant"` plus `tenant_id` for a tenant override. `scope: "global"` changes the
product-wide default, including the default inherited by tenant-scoped leaves. A stale
`expected_revision` returns `409 revision_conflict`; invalid paths, values, or scope return
`422 validation_failed`. Every successful save creates a new immutable revision and an audit
entry containing paths, never secret values.

Inspect history with:

- `GET /v1/settings/revisions`
- `GET /v1/settings/revisions/{revision}`

### How a change is stored (Cockpit: „Wie wird gespeichert?")

The Cockpit's settings page answers this once, below the list, in the same words:

> Every change is stored in the database as a new, immutable version; earlier versions stay
> traceable in the audit. Most values take effect immediately on every instance. Values marked
> „Wirkt nach Neustart" (takes effect after a restart) apply only after a restart — until then the
> previous version keeps running.

A settings row shows a setting's key only to readers who may change settings: the copy icon beside
its name copies the key for `sk settings set <key>`. The row says „Gilt für" (applies to) only for a
tenant-scoped setting or where a tenant's own value overrides the installation's.

## Hot activation and restart-required changes

Activate a saved hot-capable revision with:

```http
POST /v1/settings/revisions/{revision}/activate
```

Each engine replica heartbeats every 10 seconds. A lease is healthy for 30 seconds. During
activation every healthy replica validates and resolves the exact revision digest and writes
an ACK or NACK. The active pointer advances only after all healthy replicas ACK; activation
times out after 60 seconds and remains observable as failed otherwise.

`GET /v1/settings/activations/{revision}` lists replica health, ACK/NACK state, digest, reason,
and last heartbeat. Cockpit shows the same information.

Changes to restart-required leaves are saved but not hot-applied. Their status is
`restart_required`; `saved_revision` and `active_revision` remain different and
`pending_restart_fields` names the exact leaves. After a coordinated restart—and only after old
replica leases expire—the new process promotes that revision during boot. A later save on top
of a waiting revision keeps those leaves waiting: `pending_restart_fields` always lists every
restart-required leaf that differs from what the running process loaded.

A process that ended without its drain leaves a lease that stays healthy for up to 30 seconds.
Boot then waits, with backoff, for up to about 35 seconds for that lease to expire instead of
failing at once; only a lease that stays fresh (a replica that is really alive) still stops the
boot. Allow for that in health gates and in the supervisor's start timeout.

### Restart now

With exactly one engine instance and a supervisor that starts it again, SubKit can restart
itself:

1. Declare the supervisor once: `sk settings set server.restart_supervised true` (Cockpit:
   "Supervisor present"). SubKit does not detect it; a container or a systemd unit says nothing
   about its restart policy. The restart reads this flag from the saved revision, so switching
   it on while another change already waits for a restart enables that very restart (the
   `sk settings set` answer then says the value becomes active with it).
2. Restart from Cockpit ("Restart now" next to "Waiting for a restart") or with
   `sk system restart --wait`. Both need the admin-only permission `system:restart`.

```http
POST /v1/system/restart            → 202 { request_id, audit_id, boot_id, expected_revision }
GET  /v1/system/restart-status     → { boot_id, started_at, saved_revision, active_revision,
                                       activation_status, restart_supervised,
                                       pending_restart_fields }
```

The engine drains exactly as on `SIGTERM`—running steps get up to 2 minutes and continue after
the start—and exits with code 75. It answers `409` with a reason instead when a restart would
not help or not come back: `not_supervised`, `nothing_pending`, `multiple_replicas`, or
`restart_in_progress` (an unanswered request, or one less than a minute old). A restart is done
when `restart-status` reports a new `boot_id` and `active_revision == saved_revision`. The audit
trail records `engine.restart.requested` and, written by the next process,
`engine.restart.completed` or `engine.restart.failed` under the same `resource_id`. Without a
supervisor, restart the process where it runs (`systemctl restart subkit-engine`,
`docker compose restart engine`). There is deliberately no MCP tool for it: a restart would cut
the connection the call arrived on.

## Immutable secret versions

Create a secret version without putting plaintext into a settings document:

```http
POST /v1/secrets/llm.primary/versions
Content-Type: application/json

{ "value": "the-plaintext-is-write-only" }
```

The response contains a reference such as `secret://llm.primary/3`. Use that reference in a
settings patch. `GET /v1/secrets` returns metadata and references only—never plaintext or
ciphertext. Revoke an unreferenced version with
`POST /v1/secrets/{name}/versions/{version}/revoke`; referenced versions fail closed with 409.

## Object storage contract

All new file bodies and oversized execution payloads use the configured S3-compatible private
bucket. There is no durable local-storage mode and no PostgreSQL blob fallback for new writes.
The adapter uses SigV4, path style where configured, known Content-Length, 64 MiB multipart
parts, and only the common Head/Put/Multipart/Get-Range/List/Delete operations. Object keys are
immutable, application SHA-256 is authoritative, and ETags are opaque.

The runtime deliberately does not depend on bucket versioning, CopyObject, presigned URLs,
SSE-C, checksum headers, ACLs, tagging, lifecycle policies, or object lock.

Before adopting a new S3-compatible service, run the one-time destructive probe against a
dedicated empty test bucket:

```bash
OBJECT_STORAGE_ENDPOINT=https://objects.example.com \
OBJECT_STORAGE_REGION=garage \
OBJECT_STORAGE_BUCKET=temporary-subkit-conformance \
OBJECT_STORAGE_ACCESS_KEY_ID=... \
OBJECT_STORAGE_SECRET_ACCESS_KEY=... \
OBJECT_STORAGE_PATH_STYLE=true \
bun run storage:conformance
```

It covers small and multipart uploads, Head, bounded and open-ended Range reads,
ListObjectsV2, DeleteObject/DeleteObjects, application hash rejection, multipart abort, and a
retry using the aborted key. To verify credential rotation in the same run, also provide
`OBJECT_STORAGE_ROTATED_ACCESS_KEY_ID` and
`OBJECT_STORAGE_ROTATED_SECRET_ACCESS_KEY` (plus the optional rotated session token). The probe
prints no credentials and removes its UUID-scoped objects. It is an implementation/adoption
check, not a permanent release gate.

## Operational guarantees

- Invalid bootstrap input, an unreadable active revision, an unresolved secret, or an
  unreachable object bucket fails startup before readiness.
- PostgreSQL is the source of truth for non-fundamental runtime configuration, revision state, secret metadata,
  object pointers, and audits.
- Cockpit, HTTP, MCP, CLI, OpenAPI, and generated `llm*.txt` describe the same activation model.
- Scratch files may use the container's ephemeral filesystem, but no product state requires a
  persistent `/data` mount.

## See also

- [Settings reference](./settings-reference.md)
- [Production hardening](./production-hardening.md)
- [Self-hosting](../developers/self-host.md)
