// Integration test for /v1/diagnostics/logs and /v1/diagnostics/logs/stream.
//
// Drives the live engine, drops a structured log line via the engine's
// own logger module, and asserts both the paginated tail and the SSE
// stream surface it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gte } from "drizzle-orm";
import { apiKeys, auditLog, users } from "../../db/schema/index.ts";
import { withContext } from "../../logging/context.ts";
import { logger } from "../../logging/logger.ts";
import { logRing } from "../../observability/log-ring.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;
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
});

afterAll(async () => {
  // Drain the ring before tearing down so a neighbouring suite picking
  // up the singleton doesn't see leftover synthetic entries.
  logRing.clear();
  await srv.cleanup();
});

function adminHeaders() {
  return {
    authorization: `Bearer ${srv.apiKey}`,
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
      { headers: adminHeaders() },
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

    // Assert the JSON-tail audit row landed.
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
      headers: adminHeaders(),
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

  test("tail filters foreign-tenant entries before serving", async () => {
    const FOREIGN_TENANT = "00000000-0000-0000-0000-000000000fee";
    const before = Date.now(); // allow-wall-clock: ring window bound
    // Emit one log line under a different tenant context — must not be
    // visible to this admin (tenant isolation on the log tail).
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
    // Sanity: the local tenant should not see it.
    const foreignRes = await fetch(
      `${srv.baseUrl}/v1/diagnostics/logs?since=${before - 100}&module=test_tenant_leak`,
      { headers: adminHeaders() },
    );
    expect(foreignRes.status).toBe(200);
    const foreignBody = (await foreignRes.json()) as {
      entries: Array<{ action?: string; fields?: { tenant_id?: string } }>;
    };
    const foreignActions = foreignBody.entries.map((e) => e.action);
    expect(foreignActions).not.toContain("foreign_emitted");

    // Same tenant context → visible.
    await withContext(
      { trace_id: "same-tenant-test", tenant_id: srv.tenantId, request_source: "api" },
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
      { headers: adminHeaders() },
    );
    const sameBody = (await sameRes.json()) as {
      entries: Array<{ action?: string }>;
    };
    expect(sameBody.entries.map((e) => e.action)).toContain("same_emitted");
  });

  test("system-scope entries (no tenant_id) remain visible to tenant admins", async () => {
    const before = Date.now(); // allow-wall-clock: ring window bound
    // Emit without withContext — entry has no tenant_id field. Boot
    // logs and cross-tenant subsystem logs land here; tenant admins
    // need them for operator visibility.
    logger.info({
      module: "test_system_scope",
      action: "boot_like",
      msg: "synthetic system-scope entry",
    });
    const res = await fetch(
      `${srv.baseUrl}/v1/diagnostics/logs?since=${before - 100}&module=test_system_scope`,
      { headers: adminHeaders() },
    );
    const body = (await res.json()) as { entries: Array<{ action?: string }> };
    expect(body.entries.map((e) => e.action)).toContain("boot_like");
  });

  test("SSE stream replays buffered entries then emits live ones", async () => {
    // Plant a "history" entry first.
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

    // Live emit on the next microtask now that the stream is open.
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
        } catch {
          /* heartbeat or malformed — skip */
        }
      }
      if (seen.includes("history") && seen.includes("live")) break;
    }
    ac.abort();
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }

    expect(seen).toContain("history");
    expect(seen).toContain("live");
  }, 10_000);
});
