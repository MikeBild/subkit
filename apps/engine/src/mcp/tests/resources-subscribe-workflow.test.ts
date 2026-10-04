import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { globalEmitter } from "../../pubsub/emitter.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

const TEST_NOW_MS = getTestNow();

let suite: McpTestSuite;

beforeAll(async () => {
  suite = await startMcpTestSuite("resources-subscribe-workflow");
});

afterAll(async () => {
  await suite.cleanup();
});

describe("mcp resources/subscribe workflow:// updates", () => {
  test("subscribed client receives workflow.lifecycle notifications", async () => {
    const { id } = await suite.seedWorkflow({
      slug: "w169-probe",
      name: "Probe Workflow",
      steps: [],
    });
    const client = await suite.connect();

    const received: Array<{ uri: string }> = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (notif) => {
      received.push({ uri: notif.params.uri });
    });

    await client.subscribeResource({ uri: `workflow://${id}` });

    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    const deadline = Date.now() + 15_000;
    let dispatchAttempt = 0;
    while (received.length === 0 && Date.now() < deadline) {
      dispatchAttempt++;
      await globalEmitter.dispatch({
        id: dispatchAttempt,
        tenant_id: suite.http.tenantId,
        channel: "workflow.lifecycle",
        type: "workflow.updated",
        payload: { workflow_id: id, slug: "w169-probe", version: 2 },
        created_at: new Date(TEST_NOW_MS),
      });
      await new Promise((r) => setTimeout(r, 200)); // allow-wall-clock: MCP resource subscription propagation cadence
    }
    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0]?.uri).toBe(`workflow://${id}`);
  }, 20_000);

  test("events for non-subscribed workflows are ignored", async () => {
    const { id: subscribedId } = await suite.seedWorkflow({
      slug: "w169-keep",
      name: "Kept Workflow",
      steps: [],
    });
    const { id: ignoredId } = await suite.seedWorkflow({
      slug: "w169-ignored",
      name: "Ignored Workflow",
      steps: [],
    });
    const client = await suite.connect();

    const received: Array<{ uri: string }> = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (notif) => {
      received.push({ uri: notif.params.uri });
    });
    await client.subscribeResource({ uri: `workflow://${subscribedId}` });

    await globalEmitter.dispatch({
      id: 2,
      tenant_id: suite.http.tenantId,
      channel: "workflow.lifecycle",
      type: "workflow.updated",
      payload: { workflow_id: ignoredId, slug: "w169-ignored", version: 3 },
      created_at: new Date(TEST_NOW_MS),
    });

    await new Promise((r) => setTimeout(r, 200)); // allow-wall-clock: MCP resource subscription propagation cadence
    expect(received.find((r) => r.uri.includes(ignoredId))).toBeUndefined();
  });

  test("events from a different tenant never fire — no cross-tenant leak", async () => {
    const { id } = await suite.seedWorkflow({
      slug: "w169-isolated",
      name: "Tenant-Isolated Workflow",
      steps: [],
    });
    const client = await suite.connect();

    const received: Array<{ uri: string }> = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (notif) => {
      received.push({ uri: notif.params.uri });
    });
    await client.subscribeResource({ uri: `workflow://${id}` });

    await globalEmitter.dispatch({
      id: 3,
      tenant_id: "00000000-0000-0000-0000-0000000000ff",
      channel: "workflow.lifecycle",
      type: "workflow.updated",
      payload: { workflow_id: id, slug: "w169-isolated", version: 4 },
      created_at: new Date(TEST_NOW_MS),
    });

    await new Promise((r) => setTimeout(r, 200)); // allow-wall-clock: MCP resource subscription propagation cadence
    expect(received).toHaveLength(0);
  });
});
