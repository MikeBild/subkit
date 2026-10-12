import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { and, eq } from "drizzle-orm";
import { createConnector } from "../../connectors/service.ts";
import { upsertCredential } from "../../credentials/service.ts";
import { apiKeys, auditLog, users } from "../../db/schema/index.ts";
import { createRole } from "../../rbac/roles.ts";
import { createDeterministicHexFactory } from "../../test-helpers/determinism/ids.ts";
import { createHttpTestServer, type HttpTestServer } from "../tests/setup.ts";

const hex = createDeterministicHexFactory(0xc4112_5e51);

let ctx: HttpTestServer;
let mock: Server;
let mockBaseUrl: string;
let captured: { method: string; url: string; headers: Record<string, string>; body: string }[] = [];
let nextStatus = 200;
let nextBody: string = JSON.stringify({ ok: true, data: { id: "cust_42" } });

let connectorId: string;
let connectorWithoutCredentialId: string;
let memberApiKey: string;

beforeAll(async () => {
  ctx = await createHttpTestServer("conn-call");

  mock = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers[k.toLowerCase()] = v;
      }
      captured.push({
        method: req.method ?? "GET",
        url: req.url ?? "",
        headers,
        body,
      });
      res.writeHead(nextStatus, { "content-type": "application/json" });
      res.end(nextBody);
    });
  });
  await new Promise<void>((resolve) =>
    mock.listen(0, "127.0.0.1", () => {
      resolve();
    }),
  );
  const addr = mock.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  mockBaseUrl = `http://127.0.0.1:${port}`;

  const created = await createConnector(
    {
      tenant_id: ctx.tenantId,
      input: {
        name: "Mock API",
        driver: "http",
        environment: "dev",
        base_url: mockBaseUrl,
        auth_type: "bearer",
        config: {},
      },
      actor_id: ctx.userId,
    },
    ctx.db,
  );
  connectorId = created.id;
  await upsertCredential(
    {
      tenant_id: ctx.tenantId,
      connector_id: connectorId,
      environment: "dev",
      mode: "bearer",
      value: { mode: "bearer", token: "TEST-TOKEN-call-route" },
      actor_id: ctx.userId,
    },
    ctx.db,
  );

  const noCred = await createConnector(
    {
      tenant_id: ctx.tenantId,
      input: {
        name: "Mock No Cred",
        driver: "http",
        environment: "dev",
        base_url: mockBaseUrl,
        auth_type: "bearer",
        config: {},
      },
      actor_id: ctx.userId,
    },
    ctx.db,
  );
  connectorWithoutCredentialId = noCred.id;

  const noopRole = await createRole(ctx.db, ctx.tenantId, "noop-conn-call", "no permissions");
  const [member] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "member-conn-call@test.local",
      role_id: noopRole.id,
    })
    .returning();
  if (!member) throw new Error("seed member failed");
  const rand = hex(24).slice(0, 32);
  memberApiKey = `wf_live_${rand}`;
  const prefix = memberApiKey.slice(0, 12);
  const hash = createHash("sha256").update(memberApiKey).digest("hex");
  await ctx.db.insert(apiKeys).values({
    tenant_id: ctx.tenantId,
    user_id: member.id,
    prefix,
    token_sha256: hash,
    scopes: ["*"],
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) =>
    mock.close(() => {
      resolve();
    }),
  );
  // allow-wall-clock: real ms required to flush postgres write queue.
  await new Promise((r) => setTimeout(r, 250));
  // allow-wall-clock: wall-clock cap on cleanup to avoid Bun's 5s afterAll timeout.
  await Promise.race([ctx.cleanup(), new Promise<void>((r) => setTimeout(r, 4000))]);
}, 10_000);

function adminAuth() {
  return {
    authorization: `Bearer ${ctx.apiKey}`,
    "content-type": "application/json",
  } as const;
}

describe("POST /v1/connectors/{id}/call", () => {
  test("200 — HTTP GET round-trips through the saved connector + credential", async () => {
    captured = [];
    nextStatus = 200;
    nextBody = JSON.stringify({ ok: true, data: { id: "cust_42" } });

    const res = await fetch(`${ctx.baseUrl}/v1/connectors/${connectorId}/call`, {
      method: "POST",
      headers: adminAuth(),
      body: JSON.stringify({
        method: "GET",
        path: "/v1/customers",
        query: { limit: 1 },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: number;
      headers: Record<string, string>;
      body: { ok: boolean; data: { id: string } };
      latency_ms: number;
      truncated: boolean;
      body_byte_count: number;
      metadata: { driver: string; method: string; path: string };
    };
    expect(body.status).toBe(200);
    expect(body.body.data.id).toBe("cust_42");
    expect(body.metadata.driver).toBe("http");
    expect(body.metadata.method).toBe("GET");
    expect(body.metadata.path).toBe("/v1/customers");
    expect(typeof body.latency_ms).toBe("number");
    const [audit] = await ctx.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.action, "connector.invoked"),
          eq(auditLog.resource_id, connectorId),
          eq(auditLog.actor_id, ctx.userId),
        ),
      );
    expect(audit).toEqual({ actor_type: "user", actor_id: ctx.userId });

    expect(captured.length).toBe(1);
    expect(captured[0]?.headers.authorization).toBe("Bearer TEST-TOKEN-call-route");
    expect(captured[0]?.url).toContain("limit=1");
  });

  test("4xx — upstream non-2xx surfaces as ok:true with the raw status (matches tool semantics)", async () => {
    captured = [];
    nextStatus = 404;
    nextBody = JSON.stringify({ error: { code: "not_found", message: "no such customer" } });

    const res = await fetch(`${ctx.baseUrl}/v1/connectors/${connectorId}/call`, {
      method: "POST",
      headers: adminAuth(),
      body: JSON.stringify({ method: "GET", path: "/v1/customers/nope" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: number;
      health: string;
      health_suggestion?: string;
      body: { error: { code: string } };
    };
    expect(body.status).toBe(404);
    expect(body.body.error.code).toBe("not_found");
    expect(body.health).toBe("not_found");
    expect(body.health_suggestion).toContain("not a broken connector");
  });

  test("401 — auth failure surfaces health:auth_failed with next_best_actions", async () => {
    captured = [];
    nextStatus = 401;
    nextBody = JSON.stringify({ error: "unauthorized" });

    const res = await fetch(`${ctx.baseUrl}/v1/connectors/${connectorId}/call`, {
      method: "POST",
      headers: adminAuth(),
      body: JSON.stringify({ method: "GET", path: "/v1/customers" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: number;
      health: string;
      health_suggestion?: string;
      next_best_actions?: string[];
    };
    expect(body.status).toBe(401);
    expect(body.health).toBe("auth_failed");
    expect(body.next_best_actions).toContain("setup_connector_credentials");
    expect(typeof body.health_suggestion).toBe("string");
  });

  test("403 — non-admin without connector:read is rejected at the policy gate", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/connectors/${connectorId}/call`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${memberApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ method: "GET", path: "/v1/customers" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("forbidden");
  });

  test("404 — unknown connector_id returns not_found", async () => {
    const res = await fetch(
      `${ctx.baseUrl}/v1/connectors/00000000-0000-0000-0000-000000000000/call`,
      {
        method: "POST",
        headers: adminAuth(),
        body: JSON.stringify({ method: "GET", path: "/v1/customers" }),
      },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("not_found");
  });

  test("422 — connector with no credential surfaces credential_required envelope", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/connectors/${connectorWithoutCredentialId}/call`, {
      method: "POST",
      headers: adminAuth(),
      body: JSON.stringify({ method: "GET", path: "/v1/customers" }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; details?: { error_code: string } };
    expect(body.code).toBe("unprocessable_entity");
    expect(body.details?.error_code).toBe("credential_required");
  });

  test("422 — Postgres / non-HTTP driver returns driver_not_supported envelope", async () => {
    const pg = await createConnector(
      {
        tenant_id: ctx.tenantId,
        input: {
          name: "Mock PG",
          driver: "postgres",
          environment: "dev",
          dsn: "postgres://stub",
          auth_type: "none",
          config: {},
        },
        actor_id: ctx.userId,
      },
      ctx.db,
    );
    const res = await fetch(`${ctx.baseUrl}/v1/connectors/${pg.id}/call`, {
      method: "POST",
      headers: adminAuth(),
      body: JSON.stringify({ method: "GET", path: "/" }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; details?: { error_code: string } };
    expect(body.code).toBe("unprocessable_entity");
    expect(body.details?.error_code).toBe("driver_not_supported_for_call_connector");
  });
});
