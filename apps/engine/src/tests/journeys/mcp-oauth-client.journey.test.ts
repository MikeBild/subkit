import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CODE_CHALLENGE,
  CODE_VERIFIER,
  mintSessionCookie,
  seedSession,
} from "../../auth/oauth/mcp-oauth-test-helpers.ts";
import { getConfig, setConfigKey } from "../../config/loader.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

const REDIRECT_URI = "https://client.example.com/oauth/callback";
const ADMIN_TOOLS = [
  "find_workflow",
  "diagnose_workflow",
  "find_connector",
  "list_connections",
  "list_schedules",
  "list_vault_items",
] as const;

let ctx: JourneyCtx;
let priorBaseUrl = "";
let resource = "";
let workflowId = "";
let advertised: string[] = [];
const clients: Client[] = [];

interface Grant {
  accessToken: string;
  grantedScope: string[];
  preChecked: string[];
}

interface ToolOutcome {
  isError: boolean;
  text: string;
}

beforeAll(async () => {
  ctx = await createJourneyCtx("mcp-oauth-client");
  priorBaseUrl = getConfig().server.public_base_url;
  await setConfigKey("server.public_base_url", ctx.baseUrl, { force: true });
  resource = `${ctx.baseUrl}/mcp`;

  const workflow = await journeyFetch(ctx, "/v1/workflows", {
    method: "POST",
    body: JSON.stringify({
      name: "Order status",
      slug: "order-status",
      description: "Looks up the shipping state of a customer order",
      steps: [
        { kind: "request", id: "lookup", method: "GET", url: "https://shop.example.com/orders" },
      ],
    }),
  });
  expect(workflow.status).toBe(201);
  workflowId = ((await workflow.json()) as { id: string }).id;

  const connector = await journeyFetch(ctx, "/v1/connectors", {
    method: "POST",
    body: JSON.stringify({
      name: "Shop",
      slug: "shop",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://shop.example.com",
    }),
  });
  expect(connector.status).toBe(201);

  const vault = await journeyFetch(ctx, "/v1/vault", {
    method: "POST",
    body: JSON.stringify({
      kind: "secret",
      name: "shop-token",
      scope: "workspace",
      token: "fixture-shop-token-7f3a",
    }),
  });
  expect(vault.status).toBe(201);

  const metadata = await fetch(`${ctx.baseUrl}/.well-known/oauth-authorization-server`);
  advertised = ((await metadata.json()) as { scopes_supported: string[] }).scopes_supported;
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  for (const client of clients) await client.close().catch(() => {});
  if (priorBaseUrl !== "") {
    await setConfigKey("server.public_base_url", priorBaseUrl, { force: true });
  }
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

async function register(scope?: string): Promise<string> {
  const res = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [REDIRECT_URI],
      client_name: "Journey MCP client",
      ...(scope === undefined ? {} : { scope }),
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

function attribute(tag: string, name: string): string | null {
  return tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? null;
}

function browserForm(html: string): { fields: [string, string][]; preChecked: string[] } {
  const fields: [string, string][] = [];
  const preChecked: string[] = [];
  for (const tag of html.match(/<input\b[^>]*>/g) ?? []) {
    const name = attribute(tag, "name");
    const value = attribute(tag, "value");
    if (!name || value === null) continue;
    const type = attribute(tag, "type");
    if (type === "hidden") fields.push([name, value]);
    if (type === "checkbox" && /\schecked\b/.test(tag)) {
      preChecked.push(value);
      if (!/\sdisabled\b/.test(tag)) fields.push([name, value]);
    }
  }
  return { fields, preChecked };
}

async function authorize(
  clientId: string,
  opts: { scope?: string; submit?: (preChecked: string[]) => string[] },
): Promise<Grant> {
  const sessionId = await seedSession(ctx.db, ctx.tenantId, ctx.userId);
  const cookie = `subkit_session=${await mintSessionCookie({
    session_id: sessionId,
    user_id: ctx.userId,
    tenant_id: ctx.tenantId,
  })}`;
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: "S256",
    resource,
    state: "journey-state",
    ...(opts.scope === undefined ? {} : { scope: opts.scope }),
  });
  const consent = await fetch(`${ctx.baseUrl}/v1/oauth/authorize?${query}`, {
    headers: { cookie },
    redirect: "manual",
  });
  expect(consent.status).toBe(200);
  const { fields, preChecked } = browserForm(await consent.text());

  const body = new URLSearchParams();
  for (const [name, value] of fields) {
    if (name !== "scope" || !opts.submit) body.append(name, value);
  }
  if (opts.submit) for (const scope of opts.submit(preChecked)) body.append("scope", scope);
  body.append("decision", "approve");

  const decision = await fetch(`${ctx.baseUrl}/v1/oauth/authorize/decision`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: body.toString(),
    redirect: "manual",
  });
  expect(decision.status).toBe(302);
  const code = new URL(decision.headers.get("location") ?? "").searchParams.get("code");
  expect(code).not.toBeNull();

  const token = await fetch(`${ctx.baseUrl}/v1/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code ?? "",
      code_verifier: CODE_VERIFIER,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      resource,
    }).toString(),
  });
  expect(token.status).toBe(200);
  const tokens = (await token.json()) as { access_token: string; scope: string };
  return {
    accessToken: tokens.access_token,
    grantedScope: tokens.scope.split(" ").filter(Boolean),
    preChecked,
  };
}

async function connect(accessToken: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(resource), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: "mcp-oauth-journey", version: "0.0.0" });
  await client.connect(transport as unknown as Transport);
  clients.push(client);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  return {
    isError: result.isError === true,
    text: content.map((part) => part.text ?? "").join("\n"),
  };
}

function argsFor(tool: (typeof ADMIN_TOOLS)[number]): Record<string, unknown> {
  if (tool === "find_workflow") return { query: "shipping state" };
  if (tool === "diagnose_workflow") return { workflow_id: workflowId, environment: "dev" };
  if (tool === "find_connector") return { query: "shop" };
  return {};
}

async function expectAdminToolsSucceed(client: Client): Promise<Record<string, string>> {
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  expect(names).toEqual(expect.arrayContaining([...ADMIN_TOOLS]));
  const texts: Record<string, string> = {};
  for (const tool of ADMIN_TOOLS) {
    const outcome = await call(client, tool, argsFor(tool));
    expect({ tool, isError: outcome.isError }).toEqual({ tool, isError: false });
    expect(outcome.text).not.toContain("credential_ceiling");
    texts[tool] = outcome.text;
  }
  expect(texts.find_workflow).toContain("order-status");
  expect(texts.find_connector).toContain("shop");
  expect(texts.list_vault_items).toContain("shop-token");
  return texts;
}

describe("an MCP OAuth client connected by an admin can use the admin tools", () => {
  test("the advertised scopes include metrics:read and the /mcp challenge does not hint it", async () => {
    expect(advertised).toEqual(
      expect.arrayContaining(["mcp:read", "mcp:authoring", "mcp:admin", "metrics:read"]),
    );
    const res = await fetch(resource, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate") ?? "").not.toContain("metrics:read");
  });

  test("DCR without a scope: consent does not pre-tick metrics:read and every admin tool succeeds", async () => {
    const grant = await authorize(await register(), {});
    expect(grant.preChecked).toEqual(
      expect.arrayContaining(["mcp:read", "mcp:authoring", "mcp:admin"]),
    );
    expect(grant.preChecked).not.toContain("metrics:read");
    expect(grant.grantedScope).not.toContain("metrics:read");
    await expectAdminToolsSucceed(await connect(grant.accessToken));
  });

  test("DCR with every advertised scope: consent does not pre-tick metrics:read and every admin tool succeeds", async () => {
    const all = advertised.join(" ");
    const grant = await authorize(await register(all), { scope: all });
    expect(grant.preChecked).not.toContain("metrics:read");
    expect(grant.grantedScope).toEqual(expect.arrayContaining(["mcp:admin"]));
    await expectAdminToolsSucceed(await connect(grant.accessToken));
  });

  test("an admin who keeps metrics:read ticked is not narrowed to it", async () => {
    const all = advertised.join(" ");
    const grant = await authorize(await register(all), { scope: all, submit: () => advertised });
    expect(grant.grantedScope).toEqual(
      expect.arrayContaining(["mcp:read", "mcp:authoring", "mcp:admin", "metrics:read"]),
    );
    await expectAdminToolsSucceed(await connect(grant.accessToken));
  });
});

describe("narrow MCP OAuth grants stay narrow", () => {
  test("an mcp:read grant sees fewer tools and is refused a write tool", async () => {
    const all = advertised.join(" ");
    const admin = await authorize(await register(all), { scope: all });
    const adminTools = (await (await connect(admin.accessToken)).listTools()).tools.map(
      (tool) => tool.name,
    );

    const reader = await authorize(await register("mcp:read"), {
      scope: "mcp:read",
      submit: () => ["mcp:read"],
    });
    expect(reader.grantedScope).toEqual(["mcp:read"]);
    const client = await connect(reader.accessToken);
    const readerTools = (await client.listTools()).tools.map((tool) => tool.name);
    expect(readerTools.length).toBeLessThan(adminTools.length);
    expect(readerTools).toContain("find_workflow");
    expect(readerTools).not.toContain("delete_workflow");
    expect(adminTools).toContain("delete_workflow");

    const found = await call(client, "find_workflow", { query: "shipping state" });
    expect(found.isError).toBe(false);
    const refused = await call(client, "delete_workflow", { workflow_id: workflowId });
    expect(refused.isError).toBe(true);
    const still = await journeyFetch(ctx, `/v1/workflows/${workflowId}`);
    expect(still.status).toBe(200);
  });

  test("a metrics:read-only token reads /metrics and is refused the MCP tools", async () => {
    const grant = await authorize(await register("metrics:read"), { scope: "metrics:read" });
    expect(grant.preChecked).toEqual(["metrics:read"]);
    expect(grant.grantedScope).toEqual(["metrics:read"]);

    const scrape = await fetch(`${ctx.baseUrl}/metrics`, {
      headers: { authorization: `Bearer ${grant.accessToken}` },
    });
    expect(scrape.status).toBe(200);

    const client = await connect(grant.accessToken);
    const diagnosed = await call(client, "diagnose_workflow", argsFor("diagnose_workflow"));
    expect(diagnosed.isError).toBe(true);
    expect(diagnosed.text).toContain("credential_ceiling");
    const schedules = await call(client, "list_schedules", {});
    expect(schedules.isError).toBe(true);
    expect(schedules.text).toContain("credential_ceiling");
    const vault = await call(client, "list_vault_items", {});
    expect(vault.isError).toBe(true);
    expect(vault.text).toContain("credential_ceiling");
    expect(vault.text).not.toContain("shop-token");
  });
});
