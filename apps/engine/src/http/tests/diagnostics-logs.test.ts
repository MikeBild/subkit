// Integration test for /v1/diagnostics/logs and /v1/diagnostics/logs/stream.
//
// Drives the live engine, drops a structured log line via the engine's
// own logger module, and asserts both the paginated tail and the SSE
// stream surface it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { apiKeys, users } from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import { logRing } from "../../observability/log-ring.ts";
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
    .values({ tenant_id: srv.tenantId, email: "member-logs@test.local", role: "member" })
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
  test("paginated tail returns recent entries", async () => {
    const before = Date.now(); // allow-wall-clock: bound for the live ring tail; not a determinism axis
    logger.warn({
      module: "test_logs",
      action: "fixture_emitted",
      msg: "synthetic warn for diagnostics-logs test",
      tag: "alpha",
    });
    const res = await fetch(
      `${srv.baseUrl}/v1/diagnostics/logs?since=${before - 100}&module=test_logs`,
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
  });

  test("audit:read is required — member gets 403", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/diagnostics/logs`, {
      headers: { authorization: `Bearer ${memberKey}` },
    });
    expect(res.status).toBe(403);
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
