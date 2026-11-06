import { describe, expect, test } from "bun:test";
import {
  cockpitSession,
  connectorId,
  getStateRow,
  server,
  setupConnectorOauth,
} from "../../tests/connector-oauth-fixtures.ts";

setupConnectorOauth();

describe("POST /v1/connectors/{id}/oauth/start records where the flow began", () => {
  async function originOf(state: string): Promise<string | null | undefined> {
    return (await getStateRow(state))?.origin;
  }

  test("an API key is a terminal flow", async () => {
    const res = await fetch(`${server.baseUrl}/v1/connectors/${connectorId}/oauth/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${server.apiKey}` },
    });
    expect(res.status).toBe(200);
    const { state } = (await res.json()) as { state: string };
    expect(await originOf(state)).toBe("cli");
  });

  test("the Cockpit's own request under a live session is a Cockpit flow", async () => {
    const { headers } = await cockpitSession();
    const res = await fetch(`${server.baseUrl}/v1/connectors/${connectorId}/oauth/start`, {
      method: "POST",
      headers,
    });
    expect(res.status).toBe(200);
    const { state } = (await res.json()) as { state: string };
    expect(await originOf(state)).toBe("cockpit");
  });

  test("claiming to be the Cockpit with an API key is still a terminal flow", async () => {
    const res = await fetch(`${server.baseUrl}/v1/connectors/${connectorId}/oauth/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${server.apiKey}`, "x-subkit-client": "cockpit" },
    });
    expect(res.status).toBe(200);
    const { state } = (await res.json()) as { state: string };
    expect(await originOf(state)).toBe("cli");
  });
});
