#!/usr/bin/env bun
//
// Issue #149 acceptance — engine-only compose stack with in-process
// migrations + seed.
//
// Asserts:
//   1. The compose project no longer contains `migrate` or `seed`
//      services. The engine is the only artifact that touches the DB.
//   2. `GET /v1/health` returns `db_connected: true` and
//      `db_schema_drift: false` against a fresh DB.
//   3. The engine container's logs contain the in-process
//      `migrate.applied` line (proves the binary did its own migration).
//   4. `GET /v1/diagnostics/drift` (admin-auth required) reports an
//      embedded migration count > 0, db count == embedded count, and
//      empty `unknown_in_db` / `missing_in_db`.
//   5. `GET /v1/diagnostics/logs?since=0&module=db&action=migrate.applied`
//      surfaces the structured boot log for `sk logs --follow`.
//   6. Contract test for review W6 — `GET /v1/diagnostics/logs/stream`
//      handshake completes with `text/event-stream`. A path rename in
//      the engine route or in `cli-core/diagnostics-paths.ts` would
//      surface as a 404 here.

import { DIAGNOSTICS_LOG_STREAM_PATH } from "@cli-core/diagnostics-paths.ts";
import { BASE_URL, fail, ok, readDevApiKey, runCommand, waitForHealth } from "./_helpers.ts";

async function main(): Promise<void> {
  // ----- 1. Compose project layout -----
  const services = runCommand("docker", ["compose", "config", "--services"]);
  if (services.status !== 0) fail(`docker compose config failed:\n${services.stderr}`);
  const list = services.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.includes("migrate")) fail("compose still defines a `migrate` service — should be gone");
  if (list.includes("seed")) fail("compose still defines a `seed` service — should be gone");
  ok(`compose project has no migrate/seed services (services: ${list.join(", ")})`);

  // ----- 2. Health endpoint surfaces drift flag -----
  const health = await waitForHealth();
  if (health.db_schema_drift !== false) {
    fail(`expected db_schema_drift=false on a fresh DB, got ${JSON.stringify(health)}`);
  }
  ok(`/v1/health → status=ok db_connected=true db_schema_drift=false`);

  // ----- 3. Engine logs contain in-process migrate.applied -----
  const logs = runCommand("docker", ["compose", "logs", "engine"]);
  if (logs.status !== 0) fail(`docker compose logs engine failed:\n${logs.stderr}`);
  const combined = `${logs.stdout}\n${logs.stderr}`;
  if (!/migrate\.applied/.test(combined)) {
    fail("engine container logs do not contain `migrate.applied` — in-process migrate didn't run");
  }
  ok("engine container logs contain `migrate.applied` (in-process boot migration ran)");

  // ----- 4. Diagnostics drift endpoint -----
  const apiKey = readDevApiKey();
  const driftRes = await fetch(`${BASE_URL}/v1/diagnostics/drift`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!driftRes.ok) {
    fail(`/v1/diagnostics/drift returned ${driftRes.status}: ${await driftRes.text()}`);
  }
  const drift = (await driftRes.json()) as {
    engine_version: string;
    embedded_migration_count: number;
    db_migration_count: number;
    unknown_in_db: unknown[];
    missing_in_db: unknown[];
  };
  if (drift.embedded_migration_count <= 0) fail("embedded_migration_count must be > 0");
  if (drift.db_migration_count !== drift.embedded_migration_count) {
    fail(
      `db_migration_count (${drift.db_migration_count}) does not match embedded_migration_count (${drift.embedded_migration_count})`,
    );
  }
  if (drift.unknown_in_db.length !== 0)
    fail(`unknown_in_db expected []: ${JSON.stringify(drift.unknown_in_db)}`);
  if (drift.missing_in_db.length !== 0)
    fail(`missing_in_db expected []: ${JSON.stringify(drift.missing_in_db)}`);
  ok(
    `/v1/diagnostics/drift → embedded=${drift.embedded_migration_count} db=${drift.db_migration_count} no drift`,
  );

  // ----- 5. /v1/diagnostics/logs surfaces the migrate.applied event -----
  const logsRes = await fetch(
    `${BASE_URL}/v1/diagnostics/logs?since=0&module=db&action=migrate.applied&limit=10`,
    { headers: { authorization: `Bearer ${apiKey}` } },
  );
  if (!logsRes.ok) fail(`/v1/diagnostics/logs returned ${logsRes.status}`);
  const logBody = (await logsRes.json()) as {
    entries: Array<{ module?: string; action?: string }>;
  };
  const migrateEntry = logBody.entries.find((e) => e.action === "migrate.applied");
  if (!migrateEntry) {
    fail(
      `/v1/diagnostics/logs did not surface a 'db.migrate.applied' entry (entries: ${JSON.stringify(
        logBody.entries.slice(0, 3),
      )})`,
    );
  }
  ok(`/v1/diagnostics/logs surfaces structured boot log for sk logs --follow`);

  // ----- 6. SSE stream contract -----
  const ac = new AbortController();
  const streamRes = await fetch(`${BASE_URL}${DIAGNOSTICS_LOG_STREAM_PATH}?since=${Date.now()}`, {
    headers: { authorization: `Bearer ${apiKey}`, accept: "text/event-stream" },
    signal: ac.signal,
  });
  ac.abort();
  if (streamRes.status !== 200) {
    fail(`${DIAGNOSTICS_LOG_STREAM_PATH} returned ${streamRes.status}`);
  }
  const ct = streamRes.headers.get("content-type") ?? "";
  if (!ct.includes("text/event-stream")) {
    fail(`${DIAGNOSTICS_LOG_STREAM_PATH} content-type expected text/event-stream, got ${ct}`);
  }
  ok(`${DIAGNOSTICS_LOG_STREAM_PATH} returns ${ct} (path constant matches engine route)`);

  console.log("\nIssue #149 acceptance: PASS");
}

await main();
