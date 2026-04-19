// probe_connector tool tests.
//
// Uses a real HTTP mock server on an ephemeral port (Bun.serve-equivalent)
// via Node's http module so we can assert what the probe actually sent:
// resolved URL host, auth header, method, body. The test does NOT mock
// `fetch` — it proves end-to-end that placeholders are substituted and
// credentials arrive at the remote, while the audit row records only the
// token NAMES, never values.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { desc, eq } from "drizzle-orm";
import { upsertCredential } from "../../../credentials/service.ts";
import { auditLog, connectors, tenants } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import type { ToolContext } from "../index.ts";
import { probeConnectorTool, resetProbeRateLimit } from "../probe-connector.ts";

interface CapturedReq {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

const CANARY = "SHOULD-NEVER-APPEAR-IN-AUDIT-c4n4ry";

let ctx: TestDb;
let server: Server;
let baseUrl: string;
let captured: CapturedReq[] = [];
let nextResponse: { status: number; body: string; headers?: Record<string, string> } = {
  status: 200,
  body: JSON.stringify({ data: [{ id: "cust_42", email: "ada@example.test" }] }),
  headers: { "content-type": "application/json" },
};

beforeAll(async () => {
  ctx = await createTestDb("probe_connector");
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const url = req.url ?? "";
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers[k.toLowerCase()] = v;
      }
      captured.push({
        method: req.method ?? "GET",
        url,
        headers,
        body,
      });
      if (url.includes("/slow")) {
        setTimeout(() => {
          const h = nextResponse.headers ?? { "content-type": "application/json" };
          res.writeHead(nextResponse.status, h);
          res.end(nextResponse.body);
        }, 250);
        return;
      }
      const h = nextResponse.headers ?? { "content-type": "application/json" };
      res.writeHead(nextResponse.status, h);
      res.end(nextResponse.body);
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      resolve();
    }),
  );
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
  await ctx.cleanup();
});

beforeEach(() => {
  captured = [];
  nextResponse = {
    status: 200,
    body: JSON.stringify({ data: [{ id: "cust_42", email: "ada@example.test" }] }),
    headers: { "content-type": "application/json" },
  };
  resetProbeRateLimit();
});

afterEach(() => {
  resetProbeRateLimit();
});

async function seedProbeConnector(opts: {
  slug: string;
  environment?: "dev" | "prod";
  tokenValue?: string;
  authType?: "bearer" | "none";
}): Promise<{ tenant_id: string; conversation_id: string; connector_id: string }> {
  const [tenant] = await ctx.db
    .insert(tenants)
    .values({
      slug: `t-probe-${Math.random().toString(36).slice(2, 10)}`,
      display_name: "T",
    })
    .returning();
  const [conn] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: tenant!.id,
      slug: opts.slug,
      display_name: opts.slug,
      driver: "http",
      environment: opts.environment ?? "dev",
      auth_type: opts.authType ?? "bearer",
      base_url: baseUrl,
    })
    .returning();
  if ((opts.authType ?? "bearer") === "bearer") {
    await upsertCredential(
      {
        tenant_id: tenant!.id,
        connector_id: conn!.id,
        environment: opts.environment ?? "dev",
        mode: "bearer",
        value: { mode: "bearer", token: opts.tokenValue ?? CANARY },
        actor_id: null,
      },
      ctx.db,
    );
  }
  return {
    tenant_id: tenant!.id,
    // Conversations table has an id — we don't need a real row for the
    // tool context except its id; inserts routed through the rate
    // bucket use conversation_id as a key.
    conversation_id: crypto.randomUUID(),
    connector_id: conn!.id,
  };
}

function makeToolContext(env: { tenant_id: string; conversation_id: string }): ToolContext {
  const engineClient = new EngineClient({
    tenant_id: env.tenant_id,
    actor_id: null,
    db: ctx.db,
  });
  return {
    db: ctx.db,
    tenant_id: env.tenant_id,
    conversation_id: env.conversation_id,
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient,
    getDraft: () => ({ workflow: { name: "", steps: [] } }),
    setDraft: async () => {},
  };
}

describe("probe_connector — dispatch + credential substitution", () => {
  test("happy path: GET dispatches, resolves cred token, returns truncated body", async () => {
    const env = await seedProbeConnector({ slug: "stripe_mock", tokenValue: CANARY });
    const tctx = makeToolContext(env);

    const result = await probeConnectorTool.execute(tctx, {
      connector_slug: "stripe_mock",
      method: "GET",
      path: "/v1/customers",
      query: { limit: 2 },
      environment: "dev",
    });

    expect(result.ok).toBe(true);
    const out = result.data as Record<string, unknown>;
    expect(out.status_code).toBe(200);
    expect(out.persistence).toBe("none");
    expect(Array.isArray(out.placeholders_used)).toBe(true);
    // body is already a plain JS object (content-type=json); confirm
    // the first customer row is visible.
    const body = out.body as { data: Array<{ id: string }> };
    expect(body.data[0]!.id).toBe("cust_42");

    // Mock server saw the request with the real auth token (bearer
    // auth header synthesised by the HTTP driver from the credential).
    expect(captured.length).toBe(1);
    const req = captured[0]!;
    expect(req.method).toBe("GET");
    expect(req.url).toContain("/v1/customers");
    expect(req.url).toContain("limit=2");
    expect(req.headers.authorization).toBe(`Bearer ${CANARY}`);
  });

  test("unresolved placeholder in custom header fails before dispatch", async () => {
    const env = await seedProbeConnector({ slug: "hd1", tokenValue: "custom-auth-v2" });
    const tctx = makeToolContext(env);

    // `${input.trace}` cannot be resolved — ctx.input is not provided
    // and the placeholder resolver returns unresolved=[...]. The probe
    // tool must refuse to dispatch in that case.
    const result = await probeConnectorTool.execute(tctx, {
      connector_slug: "hd1",
      method: "GET",
      path: "/status",
      headers: { "x-request-id": `req-\${input.trace}` },
      environment: "dev",
    });

    expect(result.ok).toBe(false);
    const data = (result.data ?? {}) as Record<string, unknown>;
    const err = (data.error ?? {}) as {
      code?: string;
      details?: { unresolved?: Array<{ token: string }> };
    };
    expect(err.code).toBe("placeholder_unresolved");
    expect(err.details?.unresolved?.[0]?.token).toBe(`\${input.trace}`);
    expect(captured.length).toBe(0);
  });

  test("non-existent slug → connector_not_found", async () => {
    const env = await seedProbeConnector({ slug: "existing" });
    const tctx = makeToolContext(env);

    const result = await probeConnectorTool.execute(tctx, {
      connector_slug: "not-here",
      method: "GET",
      environment: "dev",
    });
    expect(result.ok).toBe(false);
    const err = (result.data as { error: { code: string } }).error;
    expect(err.code).toBe("connector_not_found");
    expect(captured.length).toBe(0);
  });
});

describe("probe_connector — audit hygiene", () => {
  test("audit row records slug + host + status + placeholder names, but NOT the credential value", async () => {
    const env = await seedProbeConnector({ slug: "aud1", tokenValue: CANARY });
    const tctx = makeToolContext(env);

    const probeResult = await probeConnectorTool.execute(tctx, {
      connector_slug: "aud1",
      method: "GET",
      path: "/ping",
      environment: "dev",
    });
    // Sanity-check: the probe actually succeeded (a failed probe still writes
    // an audit, but for this test we want the success path).
    expect(probeResult.ok).toBe(true);

    // Pull all audit rows for this tenant — there should be a
    // conversation.probe_connector entry plus a credential.created entry
    // from the seed step. We find the probe one explicitly so the assertion
    // fails loudly if the row is missing.
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.tenant_id, env.tenant_id))
      .orderBy(desc(auditLog.ts));
    const row = rows.find((r) => r.action === "conversation.probe_connector");
    expect(row).toBeTruthy();
    const meta = (row!.metadata ?? {}) as Record<string, unknown>;
    expect(meta.connector_slug).toBe("aud1");
    expect(meta.environment).toBe("dev");
    expect(meta.method).toBe("GET");
    expect(meta.status_code).toBe(200);
    expect(typeof meta.url_host).toBe("string");
    expect((meta.url_host as string).startsWith("127.0.0.1")).toBe(true);
    // Canary must NOT appear anywhere in the audit row.
    const serialised = JSON.stringify(row);
    expect(serialised.includes(CANARY)).toBe(false);
  });
});

describe("probe_connector — rate limit", () => {
  test("21st call in <60s returns probe_rate_limited without dispatching", async () => {
    const env = await seedProbeConnector({ slug: "rate1" });
    const tctx = makeToolContext(env);

    let lastResult: Awaited<ReturnType<typeof probeConnectorTool.execute>> | null = null;
    for (let i = 0; i < 20; i++) {
      const r = await probeConnectorTool.execute(tctx, {
        connector_slug: "rate1",
        method: "GET",
        environment: "dev",
      });
      expect(r.ok).toBe(true);
      lastResult = r;
    }
    const overLimit = await probeConnectorTool.execute(tctx, {
      connector_slug: "rate1",
      method: "GET",
      environment: "dev",
    });
    expect(overLimit.ok).toBe(false);
    const err = (overLimit.data as { error: { code: string } }).error;
    expect(err.code).toBe("probe_rate_limited");
    expect(captured.length).toBe(20);
    expect(lastResult).toBeTruthy();
  });
});

describe("probe_connector — downstream error handling", () => {
  test("server 500 still returns ok:true with status_code=500 (probe surfaces the response)", async () => {
    nextResponse = {
      status: 500,
      body: JSON.stringify({ error: "boom" }),
      headers: { "content-type": "application/json" },
    };
    const env = await seedProbeConnector({ slug: "err1" });
    const tctx = makeToolContext(env);

    const result = await probeConnectorTool.execute(tctx, {
      connector_slug: "err1",
      method: "GET",
      environment: "dev",
    });
    expect(result.ok).toBe(true);
    const out = result.data as { status_code: number; body: { error: string } };
    expect(out.status_code).toBe(500);
    expect(out.body.error).toBe("boom");
  });

  test("connection failure returns ok:false with probe_fetch_failed", async () => {
    // Seed against a host that does not exist — server port gets closed
    // momentarily to force an ECONNREFUSED.
    const [tenant] = await ctx.db
      .insert(tenants)
      .values({ slug: `t-fail-${Math.random().toString(36).slice(2, 8)}`, display_name: "T" })
      .returning();
    await ctx.db
      .insert(connectors)
      .values({
        tenant_id: tenant!.id,
        slug: "bad_host",
        display_name: "bad_host",
        driver: "http",
        environment: "dev",
        auth_type: "none",
        base_url: "http://127.0.0.1:1", // reserved port; refused
      })
      .returning();
    const tctx = makeToolContext({
      tenant_id: tenant!.id,
      conversation_id: crypto.randomUUID(),
    });
    const result = await probeConnectorTool.execute(tctx, {
      connector_slug: "bad_host",
      method: "GET",
      environment: "dev",
    });
    expect(result.ok).toBe(false);
    const err = (result.data as { error: { code: string } }).error;
    expect(err.code).toBe("probe_fetch_failed");
  });

  test("timeout returns ok:false with probe_timeout", async () => {
    const env = await seedProbeConnector({ slug: "slow_probe", authType: "none" });
    const tctx = makeToolContext(env);
    const result = await probeConnectorTool.execute(tctx, {
      connector_slug: "slow_probe",
      method: "GET",
      path: "/slow",
      environment: "dev",
      timeout_ms: 100,
    });
    expect(result.ok).toBe(false);
    const err = (result.data as { error: { code: string; message: string } }).error;
    expect(err.code).toBe("probe_timeout");
    expect(err.message).toContain("timed out");
  });
});
