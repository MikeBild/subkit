# Deferred file-lifecycle e2e scenarios

The `tests/e2e/files-lifecycle.e2e.test.ts` suite covers the binary
end-to-end paths for the unified files surface (`sk files upload` /
`download` / `list` / `delete`, `--attach`, conversation linking, etc.).
The scenarios below were scoped for the same wave but require
infrastructure that the in-repo e2e harness does not yet boot. They
are documented here, not gated as skipped tests in CI — `test.skipIf`
blocks that never run are documentation in test-file clothing, not
coverage. Each scenario below has a follow-up ticket placeholder; pick
one up by wiring the missing infra and porting the scenario into
`files-lifecycle.e2e.test.ts`.

The harness conventions are documented at the top of
`tests/e2e/files-lifecycle.e2e.test.ts`:

- `boot()` brings up engine + Postgres + mock LLM with local-disk
  storage.
- `cli()` spawns `dist/sk` as a non-interactive subprocess.
- `run()` / `expectSuccess()` / `parseJson()` are thin helpers from
  `tests/e2e/setup.ts`.

---

## E4 — S3 backend round-trip

What it would test: upload + presigned PUT + download via a real S3
endpoint (MinIO is the obvious target) — confirms that the engine
composes correct presign URLs, the client honors them, and the bytes
round-trip without diff.

Infrastructure needed:

- MinIO testcontainer (or any S3-compatible endpoint) reachable from
  the engine process.
- `boot()` overload that sets `SK_STORAGE_BACKEND=s3` +
  `storage.files.bucket` and the access-key pair.
- A teardown step that drops the bucket so the test is hermetic.

Acceptance: the E1 lifecycle + the E3 large-file presign path both pass
against the S3 backend; the engine logs presigned PUTs at MinIO; bytes
downloaded match the source sha256.

Follow-up issue: TBD.

---

## E6 — Provider id reuse

What it would test: a conversation with one attachment and two turns
calls the Anthropic Files API exactly once for that attachment — the
second turn must reuse the `anthropic_file_id` stamped on the row by
the first turn, not re-upload.

Infrastructure needed:

- An Anthropic Files API stub (HTTP fake) that counts `POST /v1/files`
  invocations and exposes the counter on a debug endpoint.
- `boot()` wiring `LLM_PROVIDER=anthropic` and `ANTHROPIC_API_URL`
  pointing at the stub.
- The mock LLM already used in the suite does not expose this counter
  — the stub is a separate fixture.

Acceptance: counter reads `1` after two turns of the same conversation
referencing the same fid.

Follow-up issue: TBD.

---

## E7 — REPL `/upload` + `@file:fid` round-trip

What it would test: the interactive REPL accepts `/upload <path>`,
emits a `file_attached` line in stream-json, then a follow-up
`@file:fid_…` reference in a subsequent message resolves to the same
attachment in the conversation.

Infrastructure needed:

- An interactive REPL driver. The `cli()` helper runs in non-interactive
  mode (`CI=1`) which suppresses the Ink-based UI; the REPL needs a
  PTY harness or a line-based stdio adapter (engine accepts slash
  commands as raw text on stdin) to drive `/upload` + a follow-up
  prompt.

Acceptance: the REPL exits 0; the resulting conversation row has the
expected `file_link` row pointing at the upload, slug matches the
filename, and the subsequent `@file:fid_…` resolves to the same
attachment row.

Follow-up issue: TBD.

---

## E9 — Discovery from file

What it would test: `sk discovery create --file ./fixtures/openapi.json
--label test` seeds a discovery run that lands a proposal whose draft
connector embeds a `$file` ref pointing at the same uploaded fid.

Infrastructure needed:

- Discovery pipeline must accept a file input. The CLI flag already
  exists; the engine handler needs a provider stub (the mock LLM does
  not synthesize a discovery proposal).
- A poll helper that waits for the discovery run to reach `completed`
  with a deterministic timeout.

Acceptance: the proposal's draft connector contains `{ "$file": fid }`
where `fid` matches the uploaded file's id; the file row's links
include `resource_type='discovery_run'`.

Follow-up issue: TBD.

---

## E10 — Knowledge from file

What it would test: `sk knowledge-sources create --file
./fixtures/manual.md --title "Manual"` ingests the file as a knowledge
source — the resulting knowledge-source row is linked to the file row,
the chunker emits searchable chunks, and `sk knowledge-sources search
"…"` returns chunks that cite the fid.

Infrastructure needed:

- The knowledge-source chunker must be wired to the files subsystem
  (the CLI path partially exists; the engine-side chunker integration
  is the deferred bit — see C19 in the unified-files plan).
- Same provider stub posture as E9 if any embedding call is mocked.

Acceptance: chunks exist, search returns them, and the
`knowledge_sources` row has a `file_links` row pointing at the uploaded
file.

Follow-up issue: TBD.

---

## E12 — Migration backfill

What it would test: an engine started against a pre-0019 schema with
legacy `conversation_attachments` rows runs `db:migrate` to the
unified-files schema; afterward every legacy attachment surfaces via
`sk files list` and `sk files get` returns the correct metadata.

Infrastructure needed:

- A pre-migration DB fixture (a SQL dump or a programmatic seed that
  runs against the pre-0019 schema).
- A `boot()` variant that pins schema version, seeds the legacy rows,
  then runs the migration in-band.

The migration logic itself is covered at integration layer by
`apps/engine/src/db/migrations/files-migration.test.ts`; this e2e is
the binary-level acceptance.

Acceptance: every seeded legacy attachment is visible in `sk files
list` with the expected filename + content_type + sha256, and the
linked conversation surfaces them via `sk files list --linked-to
conversation:<id>`.

Follow-up issue: TBD.

---

## E14 — Range download

What it would test: `curl -H "Range: bytes=START-END"` against `GET
/v1/files/{id}/content` returns `206 Partial Content` with exactly the
requested byte slice, for at least one mid-file and one suffix range.

Infrastructure needed:

- A direct HTTP client in the e2e harness (the `sk files download` CLI
  shells the full body — a Range probe needs raw HTTP).
- A fixture file large enough that a Range request is meaningful (12
  MiB is the documented test size).

Acceptance: 206 status, `Content-Range` header matches, byte-for-byte
slice equals the source bytes at the requested offsets.

Follow-up issue: TBD.

---

## E15 — Cleanup cron lifecycle

What it would test: the cleanup cron actually reaps a pending row whose
presign expired and hard-deletes a `ready` row whose `deleted_at` is
older than 7 days.

Infrastructure needed:

- A clock-advance hook so the test does not have to wait wall-clock
  time. The cleanup-cron unit + integration tests
  (`apps/engine/src/scheduler/tests/files-cleanup.test.ts`) drive the
  runner directly with `getTestNow()`; the e2e equivalent needs the
  engine to honor an injected clock or expose a debug "run cron now"
  endpoint.

Acceptance: post-trigger, the pending row is gone from `sk files list`
and the `deleted_at` row is gone from disk + the DB.

Follow-up issue: TBD.

---

## E17 — MCP `file://<fid>` resource

What it would test: spawn the engine MCP server as a subprocess, call
`read_resource("file://<fid>")` over stdio, verify the returned bytes
match the source, and verify a `notifications/resources/updated` ping
fires when the file is updated.

Infrastructure needed:

- An MCP stdio subprocess harness (spawn `sk mcp` or the engine's MCP
  entry point, speak JSON-RPC framed by `Content-Length` headers, drive
  `initialize` + `resources/read` + subscribe).

The MCP route logic itself is covered at integration layer in
`apps/engine/src/mcp/tests/resources-file.test.ts`; this e2e is the
binary-level acceptance.

Acceptance: read returns the expected bytes, an update event fires on
finalize/delete, RBAC denial (`file:read` revoked) returns a 403-style
JSON-RPC error.

Follow-up issue: TBD.

---

## Migration audit boundary (0019 backfill)

Migration `0019_files_unify.sql` backfilled legacy
`conversation_attachments` rows and file-typed `knowledge_sources` rows
into the unified `files` + `file_links` tables (see migration header
for the row-count assertions that gate the backfill). The backfill
DOES NOT emit per-row `FILE_CREATED` / `FILE_LINK_ADDED` audit entries
— consistent with prior migrations in the repo, but worth calling out
for compliance consumers reconstructing per-file history from
`audit_log`:

- Every pre-migration attachment lands as a `files` row + a
  `file_links` row with no corresponding `file.created` /
  `file.link_added` audit entry.
- The `files.created_at` column carries the migration-time `now()`
  for backfilled rows (not the original attachment-time stamp the
  source table carried), so a SIEM consumer joining on `(tenant_id,
  resource_id)` may see a `file.created`-shaped gap at the migration
  boundary.

SIEM queries that walk `audit_log` for file lifecycle should join on
`audit_log.created_at < <migration_timestamp>` to identify the
pre-migration data and treat the absence of a `file.created` row for
those resource_ids as expected. The migration boundary is the embed
timestamp in `apps/engine/src/db/migrations/meta/_journal.json` for
the `0019_files_unify` entry (preserved in the DB at
`drizzle.__drizzle_migrations.created_at`).

Audit emission for the backfill is out of scope here — the
no-backwards-compat rule in `AGENTS.md` lets us cut clean rather than
ship synthetic system-actor audit rows from a one-shot migration. If
a compliance consumer needs the audit rows, run the upstream
backfill-replay tool (TBD) against `audit_log` rather than mutating
the migration.
