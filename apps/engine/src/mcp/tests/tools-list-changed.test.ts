import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { globalEmitter } from "../../pubsub/emitter.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

const TEST_NOW_MS = getTestNow();

const OTHER_TENANT_WORKFLOW_ID = "11111111-1111-1111-1111-111111111111";

let suite: McpTestSuite;

beforeAll(async () => {
  suite = await startMcpTestSuite("tools-list-changed");
});

afterAll(async () => {
  await suite.cleanup();
});

describe("mcp tools/list_changed on workflow.lifecycle", () => {
  test("a tenant workflow.lifecycle event fires list_changed and the new wf_ tool appears", async () => {
    const client = await suite.connect();

    let changedCount = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      changedCount++;
    });

    const { id } = await suite.seedWorkflow({
      slug: "tlc-fresh",
      name: "Fresh Catalog Tool",
      steps: [],
    });

    // allow-wall-clock: this test exercises real-time SSE notification delivery.
    const deadline = Date.now() + 15_000;
    let dispatchAttempt = 0;
    while (changedCount === 0 && Date.now() < deadline) {
      dispatchAttempt++;
      await globalEmitter.dispatch({
        id: dispatchAttempt,
        tenant_id: suite.http.tenantId,
        channel: "workflow.lifecycle",
        type: "workflow.created",
        payload: { workflow_id: id, slug: "tlc-fresh", version: 1 },
        created_at: new Date(TEST_NOW_MS),
      });
      await new Promise((r) => setTimeout(r, 200)); // allow-wall-clock: list_changed propagation + server debounce window
    }
    expect(changedCount).toBeGreaterThanOrEqual(1);

    const { tools } = await client.listTools();
    expect(tools.some((t) => t.name === "wf_tlc-fresh")).toBe(true);
  }, 20_000);

  test("events from a different tenant never fire — no cross-tenant leak", async () => {
    const client = await suite.connect();

    let changedCount = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      changedCount++;
    });

    await globalEmitter.dispatch({
      id: 99,
      tenant_id: "00000000-0000-0000-0000-0000000000ff",
      channel: "workflow.lifecycle",
      type: "workflow.created",
      payload: { workflow_id: OTHER_TENANT_WORKFLOW_ID, slug: "other-tenant-wf", version: 1 },
      created_at: new Date(TEST_NOW_MS),
    });

    await new Promise((r) => setTimeout(r, 400)); // allow-wall-clock: give any erroneous notification time to arrive
    expect(changedCount).toBe(0);
  });
});
