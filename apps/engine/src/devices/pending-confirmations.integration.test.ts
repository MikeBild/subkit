import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { requestLocalConfirmation } from "../conversations/local-confirmation.ts";
import { conversationToolCalls, events } from "../db/schema/index.ts";
import {
  enroll,
  harness,
  type Runner,
  setUpDeviceRunner,
  tearDownDeviceRunner,
} from "../http/tests/device-runner-fixtures.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { seedConversation } from "../test-helpers/seed.ts";

let runner: Runner;

beforeAll(async () => {
  await setUpDeviceRunner("device_pending_confirmations");
  runner = await enroll("MacBook (Anna)");
}, 120_000);

afterAll(async () => {
  await tearDownDeviceRunner();
}, 30_000);

async function asked(owner_id: string) {
  const { db, tenantId } = harness.server;
  const conversation = await seedConversation(db, { tenant_id: tenantId, owner_id });
  const [call] = await db
    .insert(conversationToolCalls)
    .values({
      tenant_id: tenantId,
      conversation_id: conversation.id,
      tool: "browser_press",
      input: { ref: "e12" },
      output: null,
    })
    .returning({ id: conversationToolCalls.id });
  if (!call) throw new Error("tool call fixture missing");
  const requested = await requestLocalConfirmation(db, {
    tenant_id: tenantId,
    conversation_id: conversation.id,
    tool_call_id: call.id,
    parent_message_id: null,
    actor_id: owner_id,
    tool: "browser_press",
    args: { ref: "e12" },
    question: "„Bestellen“ auf shop.example drücken?",
    device: {
      device_id: runner.device_id,
      capability: "browser",
      target: "„Bestellen“ auf shop.example",
      command_id: "c".repeat(64),
      binding_hash: "b".repeat(64),
    },
    requested_at: new Date(getTestNow()),
    limits: [],
  });
  return { conversation_id: conversation.id, tool_call_id: call.id, ...requested };
}

function list(device_id: string) {
  return fetch(`${harness.server.baseUrl}/v1/devices/${device_id}/confirmations`, {
    headers: { authorization: `Bearer ${harness.server.apiKey}` },
  });
}

describe("the steps waiting on the person's device", () => {
  test("name the conversation, the step and the confirmation the live view answers", async () => {
    const step = await asked(harness.server.userId);
    const res = await list(runner.device_id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [
        {
          confirmation_id: step.tool_call_id,
          conversation_id: step.conversation_id,
          confirmation: step.confirmation,
        },
      ],
    });
    const [event] = await harness.server.db
      .select({ payload: events.payload })
      .from(events)
      .where(
        and(
          eq(events.tenant_id, harness.server.tenantId),
          eq(events.type, "local.confirmation_requested"),
        ),
      );
    expect(event?.payload).toMatchObject({
      confirmation_id: step.tool_call_id,
      conversation_id: step.conversation_id,
      device_id: runner.device_id,
    });
  });

  test("a device that is not the caller's own is not found", async () => {
    expect((await list("00000000-0000-4000-8000-0000000000ff")).status).toBe(404);
  });
});
