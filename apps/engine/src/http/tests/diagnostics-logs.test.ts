import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gte } from "drizzle-orm";
import { apiKeys, auditLog, users } from "../../db/schema/index.ts";
import { withContext } from "../../logging/context.ts";
import { logger } from "../../logging/index.ts";
import { logRing } from "../../observability/log-ring.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { adminHeaders } from "../../test-helpers/seed.ts";
import {
  createHttpTestServer,
  createSecondaryTenant,
  type HttpTestServer,
  type SecondaryTenant,
} from "./setup.ts";

let srv: HttpTestServer;
let secondary: SecondaryTenant;
let memberKey = "";

function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

function newKey(): { plaintext: string; prefix: string; hash: string } {
  const rand = randomBytes(24).toString("base64url").slice(0, 32); // allow-random: legacy; review before changing
  const plaintext = `wf_live_${rand}`;
  return { plaintext, prefix: plaintext.slice(0, 12), hash: sha256Hex(plaintext) };
}

beforeAll(async () => {
  srv = await createHttpTestServer("diagnostics_logs");

  const [member] = await srv.db
    .insert(users)
    .values({
      tenant_id: srv.tenantId,
      email: "member-logs@test.local",
      role_id: await builtinRoleId(srv.db, "member"),
    })
    .returning();
  if (!member) throw new Error("seed member failed");
  const key = newKey();
  await srv.db.insert(apiKeys).values({
    tenant_id: srv.tenantId,
    user_id: member.id,
    prefix: key.prefix,
    token_sha256: key.hash,
    scopes: ["*"],
  });
  memberKey = key.plaintext;
  secondary = await createSecondaryTenant(srv, "diagnostics-logs");
});

afterAll(async () => {
  logRing.clear();
  await srv.cleanup();
});

function tenantAdminHeaders() {
  return {
    authorization: `Bearer ${secondary.admin.apiKey}`,
    "content-type": "application/json",
  } as const;
}

describe("/v1/diagnostics/logs", () => {
  test("paginated tail returns recent entries and writes a DIAGNOSTICS_LOGS_TAILED audit row", async () => {
    const beforeTs = Date.now(); // allow-wall-clock: bound for the live ring tail; not a determinism axis
    const auditCutoff = new Date();
    logger.warn({
      module: "test_logs",
      action: "fixture_emitted",
      msg: "synthetic warn for diagnostics-logs test",
      tag: "alpha",
    });
    const res = await fetch(
      `${srv.baseUrl}/v1/diagnostics/logs?since=${beforeTs - 100}&module=test_logs`,
      { headers: adminHeaders(srv.apiKey) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: Array<{
        ts: number;
        level: string;
        module?: string;
        action?: string;
        msg?: string;
      }>;
      next_since_ms: number;
      capacity: number;
      size: number;
    };
    const matching = body.entries.find((e) => e.action === "fixture_emitted");
    expect(matching).toBeDefined();
    expect(matching!.level).toBe("warn");
    expect(matching!.msg).toContain("diagnostics-logs test");
    expect(body.capacity).toBeGreaterThan(0);
    expect(body.size).toBeGreaterThan(0);
    expect(body.next_since_ms).toBeGreaterThanOrEqual(matching!.ts);

    const rows = await srv.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, srv.tenantId),
          eq(auditLog.action, "diagnostics.logs_tailed"),
          gte(auditLog.ts, auditCutoff),
        ),
      )
      .orderBy(desc(auditLog.ts))
      .limit(1);
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.actor_id).toBe(srv.userId);
    const meta = row.metadata as { mode?: string; module_filter?: string; returned?: number };
    expect(meta.mode).toBe("json");
    expect(meta.module_filter).toBe("test_logs");
    expect(typeof meta.returned).toBe("number");
  });

  test("audit:read is required — member gets 403", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/diagnostics/logs`, {
      headers: { authorization: `Bearer ${memberKey}` },
    });
    expect(res.status).toBe(403);
  });

  test("rejects malformed `since` query", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/diagnostics/logs?since=not-a-number`, {
      headers: adminHeaders(srv.apiKey),
    });
    expect(res.status).toBe(400);
  });

  test("audit:read is required for SSE — member gets 403", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/diagnostics/logs/stream`, {
      headers: { authorization: `Bearer ${memberKey}`, accept: "text/event-stream" },
    });
    expect(res.status).toBe(403);
  });

  test("SSE rejects malformed query bag with 400 instead of opening stream", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/diagnostics/logs/stream?level=panic`, {
      headers: { authorization: `Bearer ${srv.apiKey}`, accept: "text/event-stream" },
    });
    expect(res.status).toBe(400);
  });

  test("tail filters foreign-tenant entries before serving a non-operator workspace", async () => {
    const FOREIGN_TENANT = "00000000-0000-0000-0000-000000000fee";
    const before = Date.now(); // allow-wall-clock: ring window bound
    await withContext(
      { trace_id: "tenant-leak-test", tenant_id: FOREIGN_TENANT, request_source: "api" },
      async () => {
        logger.info({
          module: "test_tenant_leak",
          action: "foreign_emitted",
          msg: "synthetic foreign-tenant entry",
        });
      },
    );
    const foreignRes = await fetch(
      `${srv.baseUrl}/v1/diagnostics/logs?since=${before - 100}&module=test_tenant_leak`,
      { headers: tenantAdminHeaders() },
    );
    expect(foreignRes.status).toBe(200);
    const foreignBody = (await foreignRes.json()) as {
      entries: Array<{ action?: string; fields?: { tenant_id?: string } }>;
    };
    const foreignActions = foreignBody.entries.map((e) => e.action);
    expect(foreignActions).not.toContain("foreign_emitted");

    await withContext(
      { trace_id: "same-tenant-test", tenant_id: secondary.tenantId, request_source: "api" },
      async () => {
        logger.info({
          module: "test_tenant_leak",
          action: "same_emitted",
          msg: "synthetic same-tenant entry",
        });
      },
    );
    const sameRes = await fetch(
      `${srv.baseUrl}/v1/diagnostics/logs?since=${before - 100}&module=test_tenant_leak`,
      { headers: tenantAdminHeaders() },
    );
    const sameBody = (await sameRes.json()) as {
      entries: Array<{ action?: string }>;
    };
    expect(sameBody.entries.map((e) => e.action)).toContain("same_emitted");
  });

  test("engine entries (no tenant_id) are visible to the engine operator only", async () => {
    const before = Date.now(); // allow-wall-clock: ring window bound
    logger.info({
      module: "test_system_scope",
      action: "boot_like",
      msg: "synthetic system-scope entry",
    });
    const res = await fetch(
      `${srv.baseUrl}/v1/diagnostics/logs?since=${before - 100}&module=test_system_scope`,
      { headers: adminHeaders(srv.apiKey) },
    );
    const body = (await res.json()) as { entries: Array<{ action?: string }> };
    expect(body.entries.map((e) => e.action)).toContain("boot_like");
    const tenantRes = await fetch(
      `${srv.baseUrl}/v1/diagnostics/logs?since=${before - 100}&module=test_system_scope`,
      { headers: tenantAdminHeaders() },
    );
    const tenantBody = (await tenantRes.json()) as { entries: Array<{ action?: string }> };
    expect(tenantBody.entries.map((e) => e.action)).not.toContain("boot_like");
  });

  test("SSE stream replays buffered entries then emits live ones", async () => {
    logger.info({
      module: "test_logs_stream",
      action: "history",
      msg: "plant history entry",
    });
    const sinceMs = Date.now() - 2000; // allow-wall-clock: ring window bound
    const ac = new AbortController();
    const res = await fetch(
      `${srv.baseUrl}/v1/diagnostics/logs/stream?since=${sinceMs}&module=test_logs_stream`,
      {
        headers: { authorization: `Bearer ${srv.apiKey}`, accept: "text/event-stream" },
        signal: ac.signal,
      },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const seen: string[] = [];
    let buffer = "";

    queueMicrotask(() => {
      logger.info({
        module: "test_logs_stream",
        action: "live",
        msg: "live entry after stream open",
      });
    });

    // allow-wall-clock: bounded read deadline for the SSE stream
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        try {
          const payload = JSON.parse(dataLine.slice(6)) as { action?: string };
          if (payload.action) seen.push(payload.action);
        } catch {}
      }
      if (seen.includes("history") && seen.includes("live")) break;
    }
    ac.abort();
    try {
      reader.releaseLock();
    } catch {}

    expect(seen).toContain("history");
    expect(seen).toContain("live");
  }, 10_000);
  test("SSE stream drops live entries older than a future since bound", async () => {
    const sinceMs = Date.now() + 5000; // allow-wall-clock: future ring window bound
    const ac = new AbortController();
    const res = await fetch(
      `${srv.baseUrl}/v1/diagnostics/logs/stream?since=${sinceMs}&module=test_logs_stream_future`,
      {
        headers: { authorization: `Bearer ${srv.apiKey}`, accept: "text/event-stream" },
        signal: ac.signal,
      },
    );
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const seen: string[] = [];
    let buffer = "";

    queueMicrotask(() => {
      logRing.record({
        ts: sinceMs - 1,
        level: "info",
        module: "test_logs_stream_future",
        action: "before_since",
        fields: {},
      });
      logRing.record({
        ts: sinceMs,
        level: "info",
        module: "test_logs_stream_future",
        action: "at_since",
        fields: {},
      });
    });

    // allow-wall-clock: bounded read deadline for the SSE stream
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        try {
          const payload = JSON.parse(dataLine.slice(6)) as { action?: string };
          if (payload.action) seen.push(payload.action);
        } catch {}
      }
      if (seen.includes("at_since")) break;
    }
    ac.abort();
    try {
      reader.releaseLock();
    } catch {}

    expect(seen).toEqual(["at_since"]);
  }, 10_000);
});
