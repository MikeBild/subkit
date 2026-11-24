import { afterAll, beforeAll } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { apiKeys } from "../../../db/schema/index.ts";
import { generateKey as generateApiKey } from "../../../identity/api-key.ts";
import {
  createJourneyCtx,
  JOURNEY_HOOK_TIMEOUT,
  type JourneyCtx,
  journeyFetch,
} from "../../../tests/journeys/setup.ts";

export let ctx: JourneyCtx;

let mock: Server;

export let mockBase = "";

export let toolWfSlug: string;

export let toolWfId: string;

export let writes = 0;

export async function connect(apiKey: string = ctx.apiKey): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(ctx.mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
  });
  const client = new Client({ name: "subkit-tools-test", version: "0.0.0" });
  await client.connect(transport as unknown as Transport);
  return client;
}

export async function issueApiKey(scopes: string[]): Promise<string> {
  const key = generateApiKey();
  await ctx.db.insert(apiKeys).values({
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    prefix: key.prefix,
    token_sha256: key.hash,
    scopes,
  });
  return key.plaintext;
}

export function setupMcpTools(): void {
  writes = 0;
  mockBase = "";
  beforeAll(async () => {
    ctx = await createJourneyCtx("mcp-tools-catalog");

    mock = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/bounded-write") writes++;
      res.setHeader("content-type", "application/json");
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", () => resolve()));
    const addr = mock.address() as AddressInfo;
    mockBase = `http://127.0.0.1:${addr.port}`;

    toolWfSlug = "catalog-regression-wf";
    const createRes = await journeyFetch(ctx, "/v1/workflows", {
      method: "POST",
      body: JSON.stringify({
        name: "Catalog Regression WF",
        slug: toolWfSlug,
        steps: [{ kind: "request", id: "probe", method: "GET", url: `${mockBase}/test` }],
      }),
    });
    const wfBody = (await createRes.json()) as { id: string };
    toolWfId = wfBody.id;
  }, JOURNEY_HOOK_TIMEOUT);
  afterAll(async () => {
    await new Promise<void>((resolve) => mock.close(() => resolve()));
    await ctx.cleanup();
  }, JOURNEY_HOOK_TIMEOUT);
}
