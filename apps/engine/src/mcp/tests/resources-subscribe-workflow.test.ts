// Workflow MCP resource subscribe.
//
// Asserts the three contracts that close the tenant-leak risk called
// out in the issue:
//   1. A session subscribed to `workflow://<id>` receives a
//      `notifications/resources/updated` whenever a `workflow.lifecycle`
//      event for that workflow fires inside the session's tenant.
//   2. Events for *other* workflows on the same tenant are filtered out
//      (URI match).
//   3. Events from a *different* tenant are filtered out (tenant match).
//      This is the load-bearing isolation check the issue calls out
//      explicitly — a leak here would expose cross-tenant workflow
//      activity to any MCP client.

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

    // Re-dispatch every poll iteration rather than fire-once-and-pray;
    // see the matching comment in resources-subscribe.test.ts. MCP's
    // StreamableHTTPClientTransport opens the server-initiated SSE
    // notification stream LAZILY, and on a saturated CI runner the GET
    // /mcp request can land after the first sendResourceUpdated has
    // already fired (notification dropped — MCP is at-most-once on
    // this channel). Forwarder is idempotent, assertion is `>= 1`.
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

    // Synthesize an event under a *different* tenant_id but with the
    // same workflow_id. The resource capability MUST filter this out
    // before forwarding — anything else is a tenant leak.
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
