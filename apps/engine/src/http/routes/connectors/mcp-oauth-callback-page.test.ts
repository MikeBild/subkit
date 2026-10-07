import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getConfig, setConfigKey } from "../../../config/loader.ts";
import { mcpOauthStates } from "../../../db/schema/index.ts";
import { seedMcpConnector } from "../../../mcp/client/test-fixtures.ts";
import { now } from "../../../utils/clock.ts";
import { createHttpTestServer, type HttpTestServer } from "../../tests/setup.ts";

let server: HttpTestServer;
let connectorId = "";
let publicBaseUrlBefore = "";

beforeAll(async () => {
  server = await createHttpTestServer("mcp-oauth-callback-page");
  publicBaseUrlBefore = getConfig().server.public_base_url;
  await setConfigKey("server.public_base_url", server.baseUrl, { force: true });
  const connector = await seedMcpConnector(server.db, {
    tenant_id: server.tenantId,
    slug: "example-tickets",
    transport: "http",
    url: "https://tickets.example.org/mcp",
  });
  connectorId = connector.id;
});

afterAll(async () => {
  await setConfigKey("server.public_base_url", publicBaseUrlBefore, { force: true });
  await server.cleanup();
});

async function seedState(state: string, origin: string | null): Promise<void> {
  await server.db.insert(mcpOauthStates).values({
    tenant_id: server.tenantId,
    connector_id: connectorId,
    state,
    redirect_uri: `${server.baseUrl}/v1/connectors/mcp/oauth/callback`,
    origin,
    expires_at: new Date(now() + 5 * 60_000),
  });
}

const callback = (query: string, language = "en") =>
  fetch(`${server.baseUrl}/v1/connectors/mcp/oauth/callback?${query}`, {
    redirect: "manual",
    headers: { "accept-language": language },
  });

describe("GET /v1/connectors/mcp/oauth/callback — the result page", () => {
  test("an unknown state: the shared page, no surface named, no link", async () => {
    const res = await callback("state=nobody-holds-this&code=x", "de");
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('data-auth-contract="mcp-auth"');
    expect(body).toContain('<html lang="de">');
    expect(body).toContain("Link abgelaufen");
    expect(body).toContain("Starte die Anmeldung dort neu, wo du sie begonnen hast.");
    expect(body).not.toContain("auth-result-link");
  });

  test("a declined Cockpit flow returns to the connector page with its failure code only", async () => {
    await seedState("mcp-declined-cockpit", "cockpit");
    const res = await callback(
      "state=mcp-declined-cockpit&error=access_denied&error_description=call+this+number",
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      `${server.baseUrl}/cockpit/connectors/${connectorId}?signin_failed=provider_declined&signin_code=access_denied`,
    );
    expect(res.headers.get("location")).not.toContain("call");
    expect(await res.text()).toBe("");
    const rows = await server.db
      .select()
      .from(mcpOauthStates)
      .where(eq(mcpOauthStates.state, "mcp-declined-cockpit"));
    expect(rows).toEqual([]);
  });

  test("a declined terminal flow is sent back to the terminal and shown no link", async () => {
    await seedState("mcp-declined-cli", null);
    const body = await (await callback("state=mcp-declined-cli&error=access_denied")).text();
    expect(body).toContain("Start the sign-in again from the terminal.");
    expect(body.match(/<a\s/g)?.length).toBe(1);
    expect(body).toContain('href="/cockpit"');
  });
});
