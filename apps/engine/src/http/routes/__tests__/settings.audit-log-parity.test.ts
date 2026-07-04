// audit_log ↔ setting.applied 1:1 parity. For every successful PUT,
// the engine must emit:
//
//   exactly one audit_log row  (action=settings.changed, resource_id=<dotted>)
//   exactly one structured log (module=config, action=setting.applied, leaf=<dotted>)
//
// Either pair without the other is a divergence: an applied log with
// no audit row means a compliance gap; an audit row with no log means
// the engine PUT something through the audit layer without going
// through setConfigKey (and therefore without the loader's atomic
// rename). This sweep does N PUTs and asserts row count == log count
// == N, with bijective resource_id ↔ leaf matching.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { _resetConfigForTests, loadConfig } from "../../../config/loader.ts";
import { auditLog } from "../../../db/schema/audit.ts";
import { logRing } from "../../../observability/log-ring.ts";
import { createHttpTestServer, type HttpTestServer } from "../../tests/setup.ts";

let server: HttpTestServer;
let cfgDir: string;
// `setting.applied` leaves captured for the CURRENT test. A live
// `logRing.subscribe()` handler (installed in beforeEach) copies each
// matching entry out the instant it is recorded — so the count is
// immune to the ring buffer's FIFO eviction. A post-hoc `logRing.tail()`
// read is NOT: under concurrent CI load other test files flood the
// shared 10k-entry ring and evict this test's `setting.applied` lines
// before it reads them, yielding a short count (`Received: 6`).
let appliedLeaves: string[] = [];
let unsubscribeAppliedCapture: (() => void) | null = null;

function appliedLeavesSinceBaseline(): string[] {
  return appliedLeaves;
}

beforeAll(async () => {
  cfgDir = mkdtempSync(join(tmpdir(), "sk-cfg-parity-"));
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: "postgres://placeholder/parity", NODE_ENV: "test" },
    configPathOverride: join(cfgDir, "subkit.config.json"),
  });
  server = await createHttpTestServer("settings-audit-parity");
  const { reconfigureLogger } = await import("../../../logging/logger.ts");
  reconfigureLogger({ level: "info", format: "ndjson" });
});

afterAll(async () => {
  unsubscribeAppliedCapture?.();
  unsubscribeAppliedCapture = null;
  await server.cleanup();
  _resetConfigForTests();
  rmSync(cfgDir, { recursive: true, force: true });
});

beforeEach(async () => {
  // Capture `setting.applied` lines live (eviction-proof). Drop the
  // prior test's subscriber before installing this test's.
  appliedLeaves = [];
  unsubscribeAppliedCapture?.();
  unsubscribeAppliedCapture = logRing.subscribe((entry) => {
    if (entry.module === "config" && entry.action === "setting.applied") {
      appliedLeaves.push(String(entry.fields?.leaf ?? ""));
    }
  });
  await server.db.delete(auditLog);
  // Defense-in-depth: the test that exercises reconfigure-failure
  // wraps the seam in try/finally, but a forgotten `finally` (or a
  // crash in beforeEach itself) would leave the flag set and poison
  // the next test's reconfigure. Clearing here costs ~zero and
  // makes the seam impossible to leak.
  const { _clearReconfigureFailureForTests } = await import("../../../test-helpers/tracing.ts");
  _clearReconfigureFailureForTests();
});

async function put(
  path: string,
  value: unknown,
  opts: { force?: boolean; tenant?: string } = {},
): Promise<Response> {
  const url = opts.tenant
    ? `${server.baseUrl}/v1/settings/${path}?tenant=${opts.tenant}`
    : `${server.baseUrl}/v1/settings/${path}`;
  return fetch(url, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${server.apiKey}`,
    },
    body: JSON.stringify({ value, ...(opts.force ? { force: opts.force } : {}) }),
  });
}

describe("audit_log ↔ setting.applied bijection", () => {
  test("N successful PUTs produce exactly N audit rows and N applied logs with matching resource_id ↔ leaf", async () => {
    const writes: Array<{ path: string; value: unknown }> = [
      { path: "errors.ring_size", value: 250 },
      { path: "queue.concurrency", value: 4 },
      { path: "egress.mode", value: "permissive" },
      { path: "mcp.read_only", value: true },
      { path: "spec.allow_private_fetch", value: true },
      { path: "llm.context_1m", value: true },
      // observability.* leaves carry requiresRestart: false (4.2.0
      // hot-reload). Sweeping one of them here fences the
      // hot-reload + audit-log invariant in the same place: the
      // tracing reconfigure path must NOT short-circuit the audit
      // row write, AND the bijection check below must still account
      // for it.
      { path: "observability.langfuse.host", value: "https://lf.parity.test" },
    ];

    for (const w of writes) {
      const r = await put(w.path, w.value);
      expect(r.status, `PUT ${w.path}`).toBe(200);
    }

    const rows = await server.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "settings.changed"));
    expect(rows.length, "audit row count").toBe(writes.length);

    const appliedLeaves = appliedLeavesSinceBaseline();
    expect(appliedLeaves.length, "setting.applied log count").toBe(writes.length);

    // Bijection: every (path) appears in both sets exactly once.
    const auditPaths = rows.map((r) => r.resource_id).sort();
    const logPaths = appliedLeaves.slice().sort();
    const expected = writes.map((w) => w.path).sort();
    expect(auditPaths).toEqual(expected);
    expect(logPaths).toEqual(expected);
  });

  test("422 validation failure emits zero audit rows and zero applied logs", async () => {
    const r = await put("log.level", "bogus");
    expect(r.status).toBe(422);
    const rows = await server.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "settings.changed"));
    expect(rows.length).toBe(0);
    expect(appliedLeavesSinceBaseline().length, "applied delta").toBe(0);
  });

  // Parametrised over a few invalid forms to widen the discriminator
  // regression net: hyphen vs underscore (sk-cli vs sk_cli — the right
  // form), a retired v1 channel name (removed in 4.0.x), empty string,
  // mixed case, and not-in-allow-list values all must 400 before
  // reaching the audit writer.
  //
  // Whitespace-only mutations (leading/trailing space) are NOT in
  // this list because Hono normalizes header values per HTTP semantics
  // (RFC 7230 §3.2.4): a trimmed header IS the same header. Catching
  // those would belong on the operator's side (sk CLI sends without
  // whitespace already).
  const INVALID_AUDIT_SOURCES = [
    "automation", // retired v1 channel name, no longer a valid source
    "sk-cli", // hyphen instead of underscore — common operator typo
    "SK_CLI", // wrong case
    "", // empty string
    "ui", // not in the allow-list
  ] as const;

  for (const bad of INVALID_AUDIT_SOURCES) {
    test(`rejects x-subkit-audit-source=${JSON.stringify(bad)} with 400 and writes no audit row`, async () => {
      const before = await server.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "settings.changed"));
      const url = `${server.baseUrl}/v1/settings/llm.context_1m`;
      const r = await fetch(url, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${server.apiKey}`,
          "x-subkit-audit-source": bad,
        },
        body: JSON.stringify({ value: true }),
      });
      expect(r.status, `bad value ${JSON.stringify(bad)}`).toBe(400);
      const after = await server.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "settings.changed"));
      expect(after.length, `no audit row for ${JSON.stringify(bad)}`).toBe(before.length);
    });
  }

  test("PUT /v1/settings/{path} OpenAPI doc declares the audit-source + deploy-version headers", async () => {
    // Catches the "future rename of AUDIT_SOURCE_HEADER constant
    // silently drops the OpenAPI doc / generated client header"
    // failure mode: the route file uses bracket-key lookup
    // ([AUDIT_SOURCE_HEADER]: ...), so the OpenAPI parameter name
    // is derived from the constant's value at module load. A typo
    // would make the route accept the new name AND the old name
    // disappear from the spec without breaking any other test.
    const res = await fetch(`${server.baseUrl}/openapi.json`);
    expect(res.status).toBe(200);
    const spec = (await res.json()) as {
      paths: Record<
        string,
        Record<
          string,
          {
            parameters?: Array<{ name?: string; in?: string }>;
          }
        >
      >;
    };
    const op = spec.paths?.["/v1/settings/{path}"]?.put;
    expect(op, "PUT /v1/settings/{path} present in spec").toBeDefined();
    const headers = (op?.parameters ?? []).filter((p) => p.in === "header").map((p) => p.name);
    expect(headers).toContain("x-subkit-audit-source");
    expect(headers).toContain("x-subkit-deploy-version");
  });

  test("a malformed x-subkit-deploy-version is rejected with 400 (semver-only)", async () => {
    // DeployVersionSchema requires MAJOR.MINOR.PATCH. A pre-release
    // suffix or non-numeric segment must 400 — the audit ledger
    // stays trivially queryable on the version column.
    const before = await server.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "settings.changed"));
    const url = `${server.baseUrl}/v1/settings/llm.context_1m`;
    const r = await fetch(url, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${server.apiKey}`,
        "x-subkit-audit-source": "deploy_bootstrap",
        "x-subkit-deploy-version": "4.2.0-rc.1+build123",
      },
      body: JSON.stringify({ value: true }),
    });
    expect(r.status).toBe(400);
    const after = await server.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "settings.changed"));
    expect(after.length, "no audit row written for malformed version").toBe(before.length);
  });

  test("metadata.reconfigure_failed=true lands in the audit row when reconfigureTracing throws", async () => {
    // setConfigKey catches a reconfigure throw, sets
    // reconfigureFailed=true, and
    // the route stamps it on the audit row's metadata. Without this
    // test, a future refactor that drops the catch (or the metadata
    // stamp) would leave the operator-visible "live tracer is on the
    // old config" signal silently broken.
    const { _failNextReconfigureForTests, _clearReconfigureFailureForTests } = await import(
      "../../../test-helpers/tracing.ts"
    );
    _failNextReconfigureForTests();
    try {
      const url = `${server.baseUrl}/v1/settings/observability.langfuse.host`;
      const r = await fetch(url, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${server.apiKey}`,
        },
        body: JSON.stringify({ value: "https://lf.audit-test.example/" }),
      });
      expect(r.status).toBe(200);
      const rows = await server.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "settings.changed"));
      const last = rows[rows.length - 1];
      expect(last, "audit row landed").toBeDefined();
      const meta = (last?.metadata ?? {}) as Record<string, unknown>;
      expect(meta.reconfigure_failed, "metadata.reconfigure_failed").toBe(true);
      // The route also flips requiresRestart=true so the operator
      // sees they need to restart for the new tracer config.
      expect(meta.requires_restart, "metadata.requires_restart").toBe(true);
      // Reset the leaf so subsequent tests aren't observing a stale URL.
      await fetch(url, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${server.apiKey}`,
        },
        body: JSON.stringify({ value: "" }),
      });
    } finally {
      // Defensive cleanup: even if an assertion above threw and
      // reconfigureTracing didn't run (and therefore didn't
      // read-and-clear the flag), we MUST clear it here so the next
      // unrelated test's reconfigure isn't poisoned.
      _clearReconfigureFailureForTests();
    }
  });

  test("valid x-subkit-audit-source + x-subkit-deploy-version flow into audit metadata", async () => {
    const url = `${server.baseUrl}/v1/settings/llm.context_1m`;
    const r = await fetch(url, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${server.apiKey}`,
        "x-subkit-audit-source": "deploy_bootstrap",
        "x-subkit-deploy-version": "4.2.0",
      },
      body: JSON.stringify({ value: true }),
    });
    expect(r.status).toBe(200);
    const rows = await server.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "settings.changed"));
    const last = rows[rows.length - 1];
    expect(last, "audit row landed").toBeDefined();
    const meta = (last?.metadata ?? {}) as Record<string, unknown>;
    expect(meta.audit_source).toBe("deploy_bootstrap");
    expect(meta.deploy_version).toBe("4.2.0");
  });

  test("409 restart-required (production, no force) emits zero audit rows and zero applied logs", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const r = await put("server.port", 4001);
      expect(r.status).toBe(409);
      const rows = await server.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "settings.changed"));
      expect(rows.length).toBe(0);
      expect(appliedLeavesSinceBaseline().length, "applied delta").toBe(0);
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });
});
