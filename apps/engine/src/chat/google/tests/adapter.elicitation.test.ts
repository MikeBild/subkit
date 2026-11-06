import { beforeAll, describe, expect, test } from "bun:test";
import {
  chatWorkspaces,
  conversationElicitations,
  conversations,
} from "../../../db/schema/index.ts";
import type { ChatEvent } from "../../types.ts";
import { ctx, detBytes, hits, makeAdapter, setupGoogleChatAdapter } from "./adapter-fixtures.ts";

setupGoogleChatAdapter();

describe("handleSyncInteraction — Dialog fast path (real DB)", () => {
  const SYNC_SPACE = "spaces/SYNC1";
  let conversationId = "";
  let elicitationId = "";

  const interactionEvent = (actionId: string, value: string): ChatEvent => ({
    platform: "google_chat",
    workspace_id: SYNC_SPACE,
    channel_id: SYNC_SPACE,
    user_id: "users/123",
    kind: "interaction",
    interaction: { action_id: actionId, value },
    raw: {},
  });

  beforeAll(async () => {
    await ctx.testDb.db.insert(chatWorkspaces).values({
      tenant_id: ctx.tenant_id,
      platform: "google_chat",
      workspace_id: SYNC_SPACE,
      bot_ciphertext: detBytes(1),
      bot_iv: detBytes(1),
      bot_auth_tag: detBytes(1),
    });
    const [conv] = await ctx.testDb.db
      .insert(conversations)
      .values({
        tenant_id: ctx.tenant_id,
        owner_id: ctx.user_id,
        status: "awaiting_input",
        draft: {},
      })
      .returning();
    if (!conv) throw new Error("seed conversation");
    conversationId = conv.id;
    const [elic] = await ctx.testDb.db
      .insert(conversationElicitations)
      .values({
        tenant_id: ctx.tenant_id,
        conversation_id: conv.id,
        tool_name: "ask_user_form",
        summary: "Where to?",
        input: {
          summary: "Where to?",
          body: "Pick a destination",
          fields: [
            {
              name: "city",
              label: "City",
              type: "select",
              options: [{ value: "ber", label: "Berlin" }],
            },
            { name: "when", type: "date" },
          ],
        },
        status: "pending",
      })
      .returning();
    if (!elic) throw new Error("seed elicitation");
    elicitationId = elic.id;
  });

  test("open_elicit with a seeded id returns the DIALOG sync response without enqueue", async () => {
    const adapter = makeAdapter();
    const outcome = await adapter.handleSyncInteraction({
      event: interactionEvent(
        `open_elicit:${elicitationId}`,
        JSON.stringify({ c: conversationId, o: {} }),
      ),
      db: ctx.testDb.db,
    });
    expect(outcome.handled).toBe(true);
    expect(outcome.enqueue).toBe(false);
    const response = outcome.response as {
      actionResponse: { type: string; dialogAction: { dialog: unknown } };
    };
    expect(response.actionResponse.type).toBe("DIALOG");
    const body = JSON.stringify(response.actionResponse.dialogAction.dialog);
    expect(body).toContain("Pick a destination");
    expect(body).toContain('"name":"city"');
    expect(body).toContain("DATE_ONLY");
  });

  test("open_elicit with an unknown id returns the probe-resistant NOT_FOUND dialog", async () => {
    const adapter = makeAdapter();
    const outcome = await adapter.handleSyncInteraction({
      event: interactionEvent(
        "open_elicit:00000000-0000-4000-8000-000000000001",
        JSON.stringify({ c: conversationId, o: {} }),
      ),
      db: ctx.testDb.db,
    });
    expect(outcome.handled).toBe(true);
    expect(outcome.enqueue).toBe(false);
    const response = outcome.response as {
      actionResponse: {
        type: string;
        dialogAction: { dialog?: unknown; actionStatus?: { statusCode: string } };
      };
    };
    expect(response.actionResponse.type).toBe("DIALOG");
    expect(response.actionResponse.dialogAction.actionStatus?.statusCode).toBe("NOT_FOUND");
    expect(response.actionResponse.dialogAction.dialog).toBeUndefined();
  });

  test("view_submission returns the OK close-ack AND requests the async enqueue", async () => {
    const adapter = makeAdapter();
    const outcome = await adapter.handleSyncInteraction({
      event: interactionEvent(
        "view_submission",
        JSON.stringify({ c: conversationId, e: elicitationId, k: "form" }),
      ),
      db: ctx.testDb.db,
    });
    expect(outcome.handled).toBe(true);
    expect(outcome.enqueue).toBe(true);
    const response = outcome.response as {
      actionResponse: { type: string; dialogAction: { actionStatus: { statusCode: string } } };
    };
    expect(response.actionResponse.type).toBe("DIALOG");
    expect(response.actionResponse.dialogAction.actionStatus.statusCode).toBe("OK");
  });

  test("confirm/choice/multi clicks are not handled sync — route enqueues them", async () => {
    const adapter = makeAdapter();
    const outcome = await adapter.handleSyncInteraction({
      event: interactionEvent(
        `elicit:${elicitationId}:confirm`,
        JSON.stringify({ c: conversationId, o: { confirmed: true } }),
      ),
      db: ctx.testDb.db,
    });
    expect(outcome.handled).toBe(false);
    expect(outcome.response).toBeUndefined();
  });
});

describe("renderElicitation — posts native cards to the messages endpoint", () => {
  test("text/form post the OPEN_DIALOG opener card", async () => {
    const adapter = makeAdapter();
    const before = hits.length;
    const out = await adapter.renderElicitation(
      {
        id: "elic-t1",
        conversation_id: "conv-1",
        kind: "text",
        summary: "Your name?",
      },
      { tenant_id: "t", workspace_id: "spaces/AAA", channel_id: "spaces/AAA" },
    );
    expect(out.platform_message_id.length).toBeGreaterThan(0);
    const hit = hits[before];
    expect(hit?.path).toBe("/v1/spaces/AAA/messages");
    expect(hit?.body).toContain("OPEN_DIALOG");
    expect(hit?.body).toContain("open_elicit:elic-t1");
  });

  test("confirm posts the inline two-button card", async () => {
    const adapter = makeAdapter();
    const before = hits.length;
    await adapter.renderElicitation(
      {
        id: "elic-c1",
        conversation_id: "conv-1",
        kind: "confirm",
        summary: "Save it?",
      },
      { tenant_id: "t", workspace_id: "spaces/AAA", channel_id: "spaces/AAA" },
    );
    const hit = hits[before];
    expect(hit?.body).toContain("elicit:elic-c1:confirm");
    expect(hit?.body).not.toContain("OPEN_DIALOG");
  });
});
