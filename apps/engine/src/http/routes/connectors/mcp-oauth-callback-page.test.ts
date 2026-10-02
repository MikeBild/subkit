// The MCP authorization callback answers a browser with the same result page
// as the connector OAuth callback — one renderer, worded for where the flow
// was started — and, like it, builds any link to the Cockpit itself.
//
// These tests cover the branches that need no authorization server: a state
// nobody holds, and a provider that declined. The exchange itself is covered
// by mcp/client/oauth-provider.test.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getConfig, setConfigKey } from "../../../config/loader.ts";
import { mcpOauthStates } from "../../../db/schema/index.ts";
import { seedMcpConnector } from "../../../mcp/client/test-fixtures.ts";
import { now } from "../../../utils/clock.ts";
import { createHttpTestServer, type HttpTestServer } from "../../tests/setup.ts";

let server: HttpTestServer;
let connectorId = "";
// The configured address is process-wide; hand it back as it was found.
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

  test("a declined Cockpit flow: a page with the way back, the code and no free text", async () => {
    await seedState("mcp-declined-cockpit", "cockpit");
    const res = await callback(
      "state=mcp-declined-cockpit&error=access_denied&error_description=call+this+number",
    );
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("Provider code: access_denied");
    expect(body).not.toContain("call this number");
    expect(body).toContain(`href="${server.baseUrl}/cockpit/connectors/${connectorId}"`);
    expect(body).toContain("Back to the connector");
    // Single use: the state is gone whatever the outcome.
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
    expect(body).not.toContain("auth-result-link");
  });
});
