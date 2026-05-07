import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { globalEmitter } from "../../pubsub/emitter.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

const TEST_NOW_MS = getTestNow();

let suite: McpTestSuite;

beforeAll(async () => {
  suite = await startMcpTestSuite("resources-subscribe");
});

afterAll(async () => {
  await suite.cleanup();
});

describe("mcp resources/subscribe live updates", () => {
  test("subscribed client receives notifications/resources/updated", async () => {
    const { id } = await suite.seedConnector({ slug: "sub-probe" });
    const client = await suite.connect();

    const received: Array<{ uri: string }> = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (notif) => {
      received.push({ uri: notif.params.uri });
    });

    await client.subscribeResource({ uri: `connector://${id}` });

    // Publish a synthetic outbox event into the in-process emitter. The
    // resource capability subscribes to `connector.oauth` at session start
    // and forwards updates whose payload references a subscribed
    // connector.
    await globalEmitter.dispatch({
      id: 1,
      tenant_id: suite.http.tenantId,
      channel: "connector.oauth",
      type: "connector.oauth.refreshed",
      payload: { connector_id: id },
      created_at: new Date(TEST_NOW_MS),
    });

    // Short poll loop — the notification arrives asynchronously over the
    // streamable HTTP SSE channel.
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    const deadline = Date.now() + 5_000;
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50)); // allow-wall-clock: MCP resource subscription propagation cadence
    }
    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0]?.uri).toBe(`connector://${id}`);
  });

  test("non-subscribed connector events are ignored", async () => {
    const { id: subscribedId } = await suite.seedConnector({ slug: "sub-probe-2" });
    const { id: ignoredId } = await suite.seedConnector({ slug: "sub-ignored" });
    const client = await suite.connect();

    const received: Array<{ uri: string }> = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (notif) => {
      received.push({ uri: notif.params.uri });
    });
    await client.subscribeResource({ uri: `connector://${subscribedId}` });

    await globalEmitter.dispatch({
      id: 2,
      tenant_id: suite.http.tenantId,
      channel: "connector.oauth",
      type: "connector.oauth.refreshed",
      payload: { connector_id: ignoredId },
      created_at: new Date(TEST_NOW_MS),
    });

    // Give the (non-)delivery a moment.
    await new Promise((r) => setTimeout(r, 200)); // allow-wall-clock: MCP resource subscription propagation cadence
    expect(received.find((r) => r.uri.includes(ignoredId))).toBeUndefined();
  });
});
