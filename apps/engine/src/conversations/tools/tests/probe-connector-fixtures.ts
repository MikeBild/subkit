import { afterAll, afterEach, beforeAll, beforeEach } from "bun:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { upsertCredential } from "../../../credentials/service.ts";
import { connectors, tenants } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import type { ToolContext } from "../index.ts";
import { resetProbeRateLimit } from "../probe-connector.ts";

export interface CapturedReq {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

export const CANARY = "SHOULD-NEVER-APPEAR-IN-AUDIT-c4n4ry";

export let ctx: TestDb;
export let server: Server;
export let baseUrl: string;
export let captured: CapturedReq[] = [];
export let nextResponse: { status: number; body: string; headers?: Record<string, string> } = {
  status: 200,
  body: JSON.stringify({ data: [{ id: "cust_42", email: "ada@example.test" }] }),
  headers: { "content-type": "application/json" },
};

export async function seedProbeConnector(opts: {
  slug: string;
  environment?: "dev" | "prod";
  tokenValue?: string;
  authType?: "bearer" | "none";
}): Promise<{ tenant_id: string; conversation_id: string; connector_id: string }> {
  const [tenant] = await ctx.db
    .insert(tenants)
    .values({
      slug: `t-probe-${Math.random().toString(36).slice(2, 10)}`, // allow-random: legacy; review before changing
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
    conversation_id: crypto.randomUUID(), // allow-random: legacy; review before changing
    connector_id: conn!.id,
  };
}

export function makeToolContext(env: { tenant_id: string; conversation_id: string }): ToolContext {
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

export function setNextResponse(value: typeof nextResponse): void {
  nextResponse = value;
}

export function useProbeConnectorSetup(): void {
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
          // allow-wall-clock: simulates a slow upstream; the timeout is bounded.
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
}
