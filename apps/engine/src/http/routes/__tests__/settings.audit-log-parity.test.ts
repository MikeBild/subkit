import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { _resetConfigForTests, loadConfig } from "../../../config/loader.ts";
import { auditLog } from "../../../db/schema/audit.ts";
import { logRing } from "../../../observability/log-ring.ts";
import { testEnv } from "../../../test-helpers/determinism/env.ts";
import { createHttpTestServer, type HttpTestServer } from "../../tests/setup.ts";

let server: HttpTestServer;
let cfgDir: string;
let appliedLeaves: string[] = [];
let unsubscribeAppliedCapture: (() => void) | null = null;

function appliedLeavesSinceBaseline(): string[] {
  return appliedLeaves;
}

beforeAll(async () => {
  cfgDir = mkdtempSync(join(tmpdir(), "subkit-cfg-parity-"));
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
  appliedLeaves = [];
  unsubscribeAppliedCapture?.();
  unsubscribeAppliedCapture = logRing.subscribe((entry) => {
    if (entry.module === "config" && entry.action === "setting.applied") {
      appliedLeaves.push(String(entry.fields?.leaf ?? ""));
    }
  });
  await server.db.delete(auditLog);
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

  const INVALID_AUDIT_SOURCES = ["automation", "subkit-cli", "SUBKIT_CLI", "", "ui"] as const;

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
      expect(meta.requires_restart, "metadata.requires_restart").toBe(true);
      await fetch(url, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${server.apiKey}`,
        },
        body: JSON.stringify({ value: "" }),
      });
    } finally {
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
    const prev = testEnv.NODE_ENV;
    testEnv.NODE_ENV = "production";
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
      if (prev === undefined) delete testEnv.NODE_ENV;
      else testEnv.NODE_ENV = prev;
    }
  });
});
