import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { apiKeys, users } from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;
let memberKey = "";

function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

function genKey(): { plaintext: string; prefix: string; hash: string } {
  const rand = randomBytes(24).toString("base64url").slice(0, 32); // allow-random: test isolation key
  const plaintext = `wf_live_${rand}`;
  return { plaintext, prefix: plaintext.slice(0, 12), hash: sha256Hex(plaintext) };
}

beforeAll(async () => {
  srv = await createHttpTestServer("diagnostics-rt");

  const [member] = await srv.db
    .insert(users)
    .values({
      tenant_id: srv.tenantId,
      email: "member-rt@test.local",
      role_id: await builtinRoleId(srv.db, "member"),
    })
    .returning();
  if (!member) throw new Error("seed member failed");
  const mk = genKey();
  await srv.db.insert(apiKeys).values({
    tenant_id: srv.tenantId,
    user_id: member.id,
    prefix: mk.prefix,
    token_sha256: mk.hash,
    scopes: ["*"],
  });
  memberKey = mk.plaintext;
});

afterAll(async () => {
  await srv.cleanup();
});

function adminFetch(): Promise<Response> {
  return fetch(`${srv.baseUrl}/v1/diagnostics/runtime`, {
    headers: { authorization: `Bearer ${srv.apiKey}` },
  });
}

describe("GET /v1/diagnostics/runtime — response shape", () => {
  test("returns 200 with all required fields for an operator (audit:read)", async () => {
    const res = await adminFetch();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      uptime_s: number;
      memory: {
        rss_mb: number;
        heap_used_mb: number;
        heap_total_mb: number;
        external_mb: number;
      };
      db_pool: {
        total: number;
        idle: number;
        waiting: number;
      };
      event_loop_lag_ms: number;
    };

    expect(typeof body.uptime_s).toBe("number");
    expect(Number.isFinite(body.uptime_s)).toBe(true);
    expect(body.uptime_s).toBeGreaterThanOrEqual(0);

    expect(typeof body.memory.rss_mb).toBe("number");
    expect(body.memory.rss_mb).toBeGreaterThan(0);
    expect(typeof body.memory.heap_used_mb).toBe("number");
    expect(body.memory.heap_used_mb).toBeGreaterThan(0);
    expect(typeof body.memory.heap_total_mb).toBe("number");
    expect(body.memory.heap_total_mb).toBeGreaterThan(0);
    expect(typeof body.memory.external_mb).toBe("number");
    expect(body.memory.external_mb).toBeGreaterThanOrEqual(0);

    expect(typeof body.db_pool.total).toBe("number");
    expect(body.db_pool.total).toBeGreaterThanOrEqual(0);
    expect(typeof body.db_pool.idle).toBe("number");
    expect(body.db_pool.idle).toBeGreaterThanOrEqual(0);
    expect(typeof body.db_pool.waiting).toBe("number");
    expect(body.db_pool.waiting).toBeGreaterThanOrEqual(0);

    expect(typeof body.event_loop_lag_ms).toBe("number");
    expect(Number.isFinite(body.event_loop_lag_ms)).toBe(true);
    expect(body.event_loop_lag_ms).toBeGreaterThanOrEqual(0);
  });

  test("memory fields are finite non-negative numbers (heap may exceed total during GC)", async () => {
    const res = await adminFetch();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      memory: { heap_used_mb: number; heap_total_mb: number; rss_mb: number };
    };
    expect(Number.isFinite(body.memory.heap_used_mb)).toBe(true);
    expect(body.memory.heap_used_mb).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(body.memory.heap_total_mb)).toBe(true);
    expect(body.memory.heap_total_mb).toBeGreaterThanOrEqual(0);
    expect(body.memory.rss_mb).toBeGreaterThan(0);
  });
});

describe("GET /v1/diagnostics/runtime — RBAC gate (audit:read required)", () => {
  test("unauthenticated → 401", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/diagnostics/runtime`);
    expect(res.status).toBe(401);
  });

  test("member role (no audit:read) → 403", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/diagnostics/runtime`, {
      headers: { authorization: `Bearer ${memberKey}` },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("forbidden");
  });

  test("admin (has audit:read) → 200", async () => {
    const res = await adminFetch();
    expect(res.status).toBe(200);
  });
});
