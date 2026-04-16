// Tunnel test scaffolding.
//
// Boots an isolated Postgres database, seeds a tenant + system account +
// api key, starts the `startTunnelWsServer` against that database on a
// random port, and returns a handle the test can use to connect a mock
// agent client with. A second `Bun.serve` handles the "local target"
// HTTP endpoint a test can hit through the tunnel.

import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { apiKeys, roles, systemAccounts, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { BUILTIN_ROLE_NAMES } from "../../rbac/seed.ts";
import { TunnelRegistry } from "../registry.ts";
import { startTunnelWsServer, type TunnelWsServerHandle } from "../ws-server.ts";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function generateApiKey() {
  const rand = randomBytes(24).toString("base64url").slice(0, 32);
  const plaintext = `wf_live_${rand}`;
  return { plaintext, prefix: plaintext.slice(0, 12), hash: sha256Hex(plaintext) };
}

export interface TunnelTestCtx {
  testDb: TestDb;
  tenantId: string;
  apiKey: string;
  registry: TunnelRegistry;
  server: TunnelWsServerHandle;
  wsUrl: string;
  cleanup: () => Promise<void>;
}

export async function createTunnelTestCtx(label: string): Promise<TunnelTestCtx> {
  const testDb = await createTestDb(`tunnels-${label}`);
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: `tn-${label}`, display_name: `Tunnels ${label}` })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");

  // Pass-2 C7: stamp the tunnel system account with the `tunnel_agent`
  // built-in role so the evaluator recognizes its WS upgrade attempts.
  const tunnelRoleRows = await testDb.db
    .select({ id: roles.id })
    .from(roles)
    .where(and(isNull(roles.tenant_id), eq(roles.name, BUILTIN_ROLE_NAMES.TUNNEL_AGENT)))
    .limit(1);
  const tunnelRoleId = tunnelRoleRows[0]?.id ?? null;

  const [sysAcct] = await testDb.db
    .insert(systemAccounts)
    .values({
      tenant_id: tenant.id,
      name: `tunnel-bot-${label}`,
      description: "tunnel agent test account",
      role_id: tunnelRoleId,
    })
    .returning();
  if (!sysAcct) throw new Error("seed system_account failed");

  const key = generateApiKey();
  const [apiKey] = await testDb.db
    .insert(apiKeys)
    .values({
      tenant_id: tenant.id,
      system_account_id: sysAcct.id,
      prefix: key.prefix,
      token_sha256: key.hash,
      scopes: ["tunnel_agent"],
    })
    .returning();
  if (!apiKey) throw new Error("seed api_key failed");

  const registry = new TunnelRegistry();
  const server = startTunnelWsServer({
    db: testDb.db,
    registry,
  });
  const wsUrl = `ws://127.0.0.1:${server.port}/v1/tunnels/ws`;

  return {
    testDb,
    tenantId: tenant.id,
    apiKey: key.plaintext,
    registry,
    server,
    wsUrl,
    cleanup: async () => {
      await server.stop();
      await testDb.cleanup();
    },
  };
}

/**
 * Minimal local "target" server used by the forward test.
 * Uses node:http instead of Bun.serve because Bun.serve's handler registration
 * becomes flaky under heavy parallel load in bun test, occasionally returning
 * the default "Welcome to Bun" response instead of invoking the handler.
 */
export function startLocalTargetServer(handler: (req: Request) => Response | Promise<Response>): {
  url: string;
  stop: () => Promise<void>;
} {
  const http = require("node:http") as typeof import("node:http");
  const server = http.createServer(async (nodeReq, nodeRes) => {
    const chunks: Buffer[] = [];
    for await (const chunk of nodeReq) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const url = `http://${nodeReq.headers.host ?? "127.0.0.1"}${nodeReq.url ?? "/"}`;
    const init: RequestInit = {
      method: nodeReq.method ?? "GET",
      headers: nodeReq.headers as Record<string, string>,
    };
    if (body.length > 0 && nodeReq.method !== "GET" && nodeReq.method !== "HEAD") {
      init.body = body;
    }
    const req = new Request(url, init);
    const res = await handler(req);
    nodeRes.statusCode = res.status;
    res.headers.forEach((value, key) => {
      nodeRes.setHeader(key, value);
    });
    const resText = await res.text();
    nodeRes.end(resText);
  });
  server.listen(0, "127.0.0.1");
  // Block until the server is actually listening.
  const addr = server.address();
  let port: number;
  if (addr && typeof addr === "object") {
    port = addr.port;
  } else {
    // Poll until bound (sync loop is ok here — it's < 1ms).
    const start = Date.now();
    while (Date.now() - start < 1000) {
      const a = server.address();
      if (a && typeof a === "object") {
        port = a.port;
        break;
      }
    }
    port ??= 0;
  }
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
