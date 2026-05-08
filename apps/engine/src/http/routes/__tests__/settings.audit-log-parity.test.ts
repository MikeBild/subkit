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
import { createHttpTestServer, type HttpTestServer } from "../../tests/setup.ts";

let server: HttpTestServer;
let cfgDir: string;
let captured: { module?: string; action?: string; leaf?: string; [k: string]: unknown }[];
let restoreStdout: () => void;

function attachStdoutCapture(
  buf: { module?: string; action?: string; leaf?: string; [k: string]: unknown }[],
): () => void {
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    const s = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    for (const line of s.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      try {
        buf.push(JSON.parse(t));
      } catch {
        /* not JSON */
      }
    }
    return orig(chunk);
  }) as typeof process.stdout.write;
  return () => {
    process.stdout.write = orig as typeof process.stdout.write;
  };
}

beforeAll(async () => {
  cfgDir = mkdtempSync(join(tmpdir(), "sk-cfg-parity-"));
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: "postgres://placeholder/parity", NODE_ENV: "test" },
    configPathOverride: join(cfgDir, "subkit.config.json"),
  });
  server = await createHttpTestServer("settings-audit-parity");
});

afterAll(async () => {
  await server.cleanup();
  _resetConfigForTests();
  rmSync(cfgDir, { recursive: true, force: true });
});

beforeEach(async () => {
  captured = [];
  restoreStdout = attachStdoutCapture(captured);
  await server.db.delete(auditLog);
  const { reconfigureLogger } = await import("../../../logging/logger.ts");
  reconfigureLogger({ level: "info", format: "ndjson" });
});

afterAll(() => {
  restoreStdout?.();
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
      { path: "tunnel.registry_max", value: 50 },
      { path: "queue.concurrency", value: 4 },
      { path: "egress.mode", value: "permissive" },
      { path: "mcp.read_only", value: true },
      { path: "spec.allow_private_fetch", value: true },
      { path: "llm.context_1m", value: true },
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

    const applied = captured.filter((l) => l.module === "config" && l.action === "setting.applied");
    expect(applied.length, "setting.applied log count").toBe(writes.length);

    // Bijection: every (path) appears in both sets exactly once.
    const auditPaths = rows.map((r) => r.resource_id).sort();
    const logPaths = applied.map((l) => l.leaf as string).sort();
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
    const applied = captured.filter((l) => l.module === "config" && l.action === "setting.applied");
    expect(applied.length).toBe(0);
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
      const applied = captured.filter(
        (l) => l.module === "config" && l.action === "setting.applied",
      );
      expect(applied.length).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });
});
