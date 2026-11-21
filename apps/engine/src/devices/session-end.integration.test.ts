import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { conversationElicitations, events } from "../db/schema/index.ts";
import {
  enroll,
  harness,
  type Runner,
  setUpDeviceRunner,
  tearDownDeviceRunner,
  uuid,
} from "../http/tests/device-runner-fixtures.ts";
import { seedConversation } from "../test-helpers/seed.ts";
import { openDeviceCommand } from "./channel.ts";
import { endDeviceSessions } from "./session-end.ts";

let runner: Runner;
let counter = 900;

beforeAll(async () => {
  await setUpDeviceRunner("device_session_end");
  runner = await enroll("MacBook (Anna)");
}, 120_000);

afterAll(async () => {
  await tearDownDeviceRunner();
}, 30_000);

async function sent(owner: { conversation_id?: string; task_run_id?: string }) {
  await openDeviceCommand(harness.server.db, {
    command_id: createHash("sha256").update(`session-${++counter}`).digest("hex"),
    tenant_id: harness.server.tenantId,
    device_id: runner.device_id,
    execution_id: null,
    task_run_id: owner.task_run_id ?? null,
    conversation_id: owner.conversation_id ?? null,
    step_id: "browser_open",
    authority_id: null,
    manifest_digest: null,
    kind: "browser.open",
    args: { url: "https://shop.example" },
    deadline_at: new Date(Date.now() + 60_000), // allow-wall-clock: the server checks deadlines on its clock
  });
}

async function ended() {
  return harness.server.db
    .select({ payload: events.payload })
    .from(events)
    .where(
      and(eq(events.tenant_id, harness.server.tenantId), eq(events.type, "device.session_ended")),
    )
    .orderBy(sql`${events.id}`);
}

describe("a device session ends with its turn or task run", () => {
  test("a finished turn ends the session on each device it used", async () => {
    const { db, tenantId, userId } = harness.server;
    const conversation = await seedConversation(db, { tenant_id: tenantId, owner_id: userId });
    await sent({ conversation_id: conversation.id });
    await sent({ conversation_id: conversation.id });
    expect(await endDeviceSessions(db, tenantId, { conversation_id: conversation.id })).toBe(1);
    expect((await ended()).at(-1)?.payload).toEqual({
      device_id: runner.device_id,
      conversation_id: conversation.id,
    });
  });

  test("a turn that waits for the person keeps the session open", async () => {
    const { db, tenantId, userId } = harness.server;
    const conversation = await seedConversation(db, { tenant_id: tenantId, owner_id: userId });
    await sent({ conversation_id: conversation.id });
    await db.insert(conversationElicitations).values({
      tenant_id: tenantId,
      conversation_id: conversation.id,
      tool_name: "ask_user_confirm",
      summary: "Bestellen?",
      input: {},
      status: "pending",
      expires_at: new Date(Date.now() + 60_000), // allow-wall-clock: elicitation deadline fixture
    });
    const before = (await ended()).length;
    expect(await endDeviceSessions(db, tenantId, { conversation_id: conversation.id })).toBe(0);
    expect(await ended()).toHaveLength(before);
  });

  test("a task run ends its session, a run without device steps names none", async () => {
    const { db, tenantId } = harness.server;
    const run = uuid(++counter);
    await sent({ task_run_id: run });
    expect(await endDeviceSessions(db, tenantId, { task_run_id: run })).toBe(1);
    expect((await ended()).at(-1)?.payload).toEqual({
      device_id: runner.device_id,
      task_run_id: run,
    });
    expect(await endDeviceSessions(db, tenantId, { task_run_id: uuid(++counter) })).toBe(0);
  });
});
