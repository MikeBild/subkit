// Google Chat adapter test — mock token + messages endpoints, plus a
// real test DB for the handleSyncInteraction Dialog fast path.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import {
  type ConversationTestCtx,
  createConversationTestCtx,
} from "../../../conversations/tests/setup.ts";
import {
  chatWorkspaces,
  conversationElicitations,
  conversations,
} from "../../../db/schema/index.ts";
import { createDeterministicHexFactory } from "../../../test-helpers/determinism/ids.ts";
import type { ChatEvent } from "../../types.ts";
import { GoogleChatAdapter } from "../adapter.ts";

const nextHex = createDeterministicHexFactory(0x900c4d);
const detBytes = (n: number): Buffer => Buffer.from(nextHex(n), "hex");

interface Hit {
  path: string;
  query: string;
  method: string;
  body: string;
  authorization: string;
}

const hits: Hit[] = [];
let baseUrl = "";
let server: ReturnType<typeof serve> | null = null;
let tokenCalls = 0;
let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("chat-google-adapter");
  const app = new Hono();
  app.post("/oauth2/token", async (c) => {
    tokenCalls += 1;
    return c.json({ access_token: `g-tok-${tokenCalls}`, expires_in: 3600 });
  });
  app.post("/v1/spaces/:space/messages", async (c) => {
    const body = await c.req.text();
    hits.push({
      path: c.req.path,
      query: new URL(c.req.url).search,
      method: "POST",
      body,
      authorization: c.req.header("authorization") ?? "",
    });
    // A reply targeting the sentinel "missing" thread simulates
    // REPLY_MESSAGE_OR_FAIL against a non-addressable thread (DM case).
    if (body.includes("threads/missing")) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json({ name: `spaces/AAA/messages/${hits.length}` });
  });
  app.patch("/v1/spaces/:space/messages/:id", async (c) => {
    hits.push({
      path: c.req.path,
      query: new URL(c.req.url).search,
      method: "PATCH",
      body: await c.req.text(),
      authorization: c.req.header("authorization") ?? "",
    });
    return c.json({ name: `${c.req.param("space")}/messages/${c.req.param("id")}` });
  });
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      baseUrl = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  if (server) await new Promise<void>((r) => server?.close(() => r()));
  await ctx.cleanup();
});

describe("google chat adapter", () => {
  test("token cached across send + sendApproval and approval uses cardsV2", async () => {
    const adapter = new GoogleChatAdapter({
      clientEmail: "bot@svc.gserviceaccount.com",
      staticAssertion: "stub-assertion",
      tokenEndpoint: `${baseUrl}/oauth2/token`,
      baseUrl,
    });

    await adapter.send({
      tenant_id: "t",
      workspace_id: "spaces/AAA",
      channel_id: "spaces/AAA",
      kind: "message",
      text: "hello",
    });
    await adapter.sendApproval({
      tenant_id: "t",
      workspace_id: "spaces/AAA",
      channel_id: "spaces/AAA",
      conversation_id: "conv-1",
      approval_id: "ap-1",
      summary: "commit draft",
    });

    expect(tokenCalls).toBe(1);
    expect(hits.length).toBe(2);
    expect(hits[0]?.authorization).toBe("Bearer g-tok-1");
    // channel_id carries the full resource name — the path must be
    // /v1/spaces/AAA/messages, never /v1/spaces/spaces%2FAAA/messages.
    expect(hits[0]?.path).toBe("/v1/spaces/AAA/messages");
    expect(hits[1]?.body).toContain("cardsV2");
    expect(hits[1]?.body).toContain("approve:ap-1");
  });

  test("thread reply sends messageReplyOption=REPLY_MESSAGE_OR_FAIL; 404 falls back to top-level", async () => {
    const adapter = new GoogleChatAdapter({
      clientEmail: "bot@svc.gserviceaccount.com",
      staticAssertion: "stub-assertion",
      tokenEndpoint: `${baseUrl}/oauth2/token`,
      baseUrl,
    });
    const before = hits.length;

    // Addressable thread: one POST with the reply option + thread name.
    await adapter.send({
      tenant_id: "t",
      workspace_id: "spaces/AAA",
      channel_id: "spaces/AAA",
      thread_id: "spaces/AAA/threads/BBB",
      kind: "message",
      text: "in-thread",
    });
    const threadHit = hits[before];
    expect(threadHit?.query).toContain("messageReplyOption=REPLY_MESSAGE_OR_FAIL");
    expect(threadHit?.body).toContain("spaces/AAA/threads/BBB");

    // Non-addressable thread (DM case): the OR_FAIL 404 degrades to a
    // top-level send instead of dropping the reply.
    const out = await adapter.send({
      tenant_id: "t",
      workspace_id: "spaces/AAA",
      channel_id: "spaces/AAA",
      thread_id: "spaces/AAA/threads/missing",
      kind: "message",
      text: "fallback",
    });
    expect(out.platform_message_id.length).toBeGreaterThan(0);
    const attempts = hits.slice(before + 1);
    expect(attempts.length).toBe(2);
    expect(attempts[0]?.query).toContain("REPLY_MESSAGE_OR_FAIL");
    expect(attempts[1]?.query).toBe("");
    expect(attempts[1]?.body).not.toContain("threads/missing");
  });

  test("update PATCHes the message name with an updateMask", async () => {
    const adapter = new GoogleChatAdapter({
      clientEmail: "bot@svc.gserviceaccount.com",
      staticAssertion: "stub-assertion",
      tokenEndpoint: `${baseUrl}/oauth2/token`,
      baseUrl,
    });
    const before = hits.length;
    await adapter.update(
      {
        tenant_id: "t",
        workspace_id: "spaces/AAA",
        channel_id: "spaces/AAA",
        kind: "message",
        text: "edited",
      },
      "spaces/AAA/messages/42",
    );
    const hit = hits[before];
    expect(hit?.method).toBe("PATCH");
    expect(hit?.path).toBe("/v1/spaces/AAA/messages/42");
    expect(hit?.query).toContain("updateMask=text");
  });

  test("receive() keys sessions on threadReply, not thread.name presence", async () => {
    const adapter = new GoogleChatAdapter({
      clientEmail: "bot@svc.gserviceaccount.com",
      staticAssertion: "stub-assertion",
      tokenEndpoint: `${baseUrl}/oauth2/token`,
      baseUrl,
    });
    const base = {
      space: { name: "spaces/AAA" },
      user: { name: "users/123" },
    };

    // Top-level message: thread.name is ALWAYS present on Google Chat
    // messages, so it must NOT become the session key — the dispatcher
    // falls back to the persistent space conversation.
    const topLevel = await adapter.receive({
      platform: "google_chat",
      raw: {
        ...base,
        type: "MESSAGE",
        message: {
          name: "spaces/AAA/messages/1",
          text: "hello",
          thread: { name: "spaces/AAA/threads/T1" },
        },
      },
    });
    expect(topLevel.kind).toBe("mention");
    expect(topLevel.thread_id).toBeUndefined();
    expect(topLevel.event_key).toBe("spaces/AAA/messages/1");

    // Genuine thread reply: threadReply=true → thread-scoped session.
    const reply = await adapter.receive({
      platform: "google_chat",
      raw: {
        ...base,
        type: "MESSAGE",
        message: {
          name: "spaces/AAA/messages/2",
          text: "and this",
          threadReply: true,
          thread: { name: "spaces/AAA/threads/T1" },
        },
      },
    });
    expect(reply.thread_id).toBe("spaces/AAA/threads/T1");

    // DM top-level (DMs are inline-threaded since the platform rollout,
    // but a non-reply still maps to the persistent DM conversation).
    const dm = await adapter.receive({
      platform: "google_chat",
      raw: {
        space: { name: "spaces/DM1", spaceType: "DIRECT_MESSAGE" },
        user: { name: "users/123" },
        type: "MESSAGE",
        message: {
          name: "spaces/DM1/messages/3",
          text: "hi",
          thread: { name: "spaces/DM1/threads/T9" },
        },
      },
    });
    expect(dm.thread_id).toBeUndefined();
  });

  test("receive() reads CARD_CLICKED from common.* with action.* fallback", async () => {
    const adapter = new GoogleChatAdapter({
      clientEmail: "bot@svc.gserviceaccount.com",
      staticAssertion: "stub-assertion",
      tokenEndpoint: `${baseUrl}/oauth2/token`,
      baseUrl,
    });

    // Current cardsV2 delivery: common.invokedFunction + flattened map.
    const modern = await adapter.receive({
      platform: "google_chat",
      raw: {
        type: "CARD_CLICKED",
        eventTime: "2026-01-01T00:00:00Z",
        space: { name: "spaces/AAA" },
        user: { name: "users/123" },
        message: { name: "spaces/AAA/messages/9", thread: { name: "spaces/AAA/threads/T1" } },
        common: {
          invokedFunction: "approve",
          parameters: { action_id: "approve:ap-7", value: "conv-7" },
        },
      },
    });
    expect(modern.kind).toBe("interaction");
    expect(modern.interaction).toEqual({ action_id: "approve:ap-7", value: "conv-7" });
    // Two different clicks on the same card message must not dedup-collide:
    // the eventTime disambiguates.
    expect(modern.event_key).toContain("2026-01-01T00:00:00Z");

    // Legacy cards-v1 shape still parses.
    const legacy = await adapter.receive({
      platform: "google_chat",
      raw: {
        type: "CARD_CLICKED",
        space: { name: "spaces/AAA" },
        user: { name: "users/123" },
        message: { name: "spaces/AAA/messages/9", thread: { name: "spaces/AAA/threads/T1" } },
        action: {
          actionMethodName: "approve",
          parameters: [
            { key: "action_id", value: "approve:ap-8" },
            { key: "value", value: "conv-8" },
          ],
        },
      },
    });
    expect(legacy.interaction).toEqual({ action_id: "approve:ap-8", value: "conv-8" });
  });

  test("receive() maps non-MESSAGE event types to system events", async () => {
    const adapter = new GoogleChatAdapter({
      clientEmail: "bot@svc.gserviceaccount.com",
      staticAssertion: "stub-assertion",
      tokenEndpoint: `${baseUrl}/oauth2/token`,
      baseUrl,
    });
    const removed = await adapter.receive({
      platform: "google_chat",
      raw: {
        type: "REMOVED_FROM_SPACE",
        space: { name: "spaces/AAA" },
        user: { name: "users/123" },
      },
    });
    expect(removed.kind).toBe("system");
    expect(removed.system_event).toBe("removed_from_space");

    const appHome = await adapter.receive({
      platform: "google_chat",
      raw: {
        type: "APP_HOME",
        eventTime: "2026-01-01T00:00:01Z",
        space: { name: "spaces/AAA" },
        user: { name: "users/123" },
      },
    });
    expect(appHome.kind).toBe("system");
    expect(appHome.system_event).toBe("APP_HOME");
  });
});

const makeAdapter = (): GoogleChatAdapter =>
  new GoogleChatAdapter({
    clientEmail: "bot@svc.gserviceaccount.com",
    staticAssertion: "stub-assertion",
    tokenEndpoint: `${baseUrl}/oauth2/token`,
    baseUrl,
  });

describe("receive() — form_values extraction", () => {
  const cardClick = (
    actionId: string,
    value: string,
    formInputs?: Record<string, unknown>,
  ): { platform: "google_chat"; raw: Record<string, unknown> } => ({
    platform: "google_chat",
    raw: {
      type: "CARD_CLICKED",
      eventTime: "2026-01-01T00:00:02Z",
      space: { name: "spaces/AAA" },
      user: { name: "users/123" },
      message: { name: "spaces/AAA/messages/9", thread: { name: "spaces/AAA/threads/T1" } },
      common: {
        invokedFunction: "submit",
        parameters: { action_id: actionId, value },
        ...(formInputs ? { formInputs } : {}),
      },
    },
  });

  test("multi:submit maps the CHECK_BOX `values` widget to form_values.values array", async () => {
    const adapter = makeAdapter();
    const ev = await adapter.receive(
      cardClick(
        "elicit:elic-1:multi:submit",
        JSON.stringify({ c: "conv-1", o: { kind: "multi" } }),
        {
          values: { stringInputs: { value: ["a", "b"] } },
        },
      ),
    );
    expect(ev.kind).toBe("interaction");
    expect(ev.interaction?.form_values).toEqual({ values: ["a", "b"] });
  });

  test("multi:submit with nothing checked yields an empty values array", async () => {
    const adapter = makeAdapter();
    const ev = await adapter.receive(
      cardClick(
        "elicit:elic-1:multi:submit",
        JSON.stringify({ c: "conv-1", o: { kind: "multi" } }),
      ),
    );
    expect(ev.interaction?.form_values).toEqual({ values: [] });
  });

  test("view_submission unwraps scalars and converts dateInput to YYYY-MM-DD", async () => {
    const adapter = makeAdapter();
    const ev = await adapter.receive(
      cardClick("view_submission", JSON.stringify({ c: "conv-1", e: "elic-1", k: "form" }), {
        city: { stringInputs: { value: ["Berlin"] } },
        when: { dateInput: { msSinceEpoch: "0" } },
      }),
    );
    expect(ev.kind).toBe("interaction");
    expect(ev.interaction?.form_values).toEqual({ city: "Berlin", when: "1970-01-01" });
  });

  test("legacy SUBMIT_FORM dialog submit routes as an interaction, not a system event", async () => {
    const adapter = makeAdapter();
    const ev = await adapter.receive({
      platform: "google_chat",
      raw: {
        type: "SUBMIT_FORM",
        eventTime: "2026-01-01T00:00:03Z",
        space: { name: "spaces/AAA" },
        user: { name: "users/123" },
        common: {
          invokedFunction: "submit_elicit",
          parameters: {
            action_id: "view_submission",
            value: JSON.stringify({ c: "conv-1", e: "elic-1", k: "text" }),
          },
          formInputs: { answer: { stringInputs: { value: ["forty-two"] } } },
        },
      },
    });
    expect(ev.kind).toBe("interaction");
    expect(ev.system_event).toBeUndefined();
    expect(ev.interaction?.action_id).toBe("view_submission");
    expect(ev.interaction?.form_values).toEqual({ answer: "forty-two" });
  });

  test("confirm button click carries the envelope value and NO form_values", async () => {
    const adapter = makeAdapter();
    const envelope = JSON.stringify({ c: "conv-1", o: { confirmed: true } });
    const ev = await adapter.receive(cardClick("elicit:elic-1:confirm", envelope));
    expect(ev.kind).toBe("interaction");
    expect(ev.interaction).toEqual({ action_id: "elicit:elic-1:confirm", value: envelope });
    expect(ev.interaction?.form_values).toBeUndefined();
  });
});

describe("receive() — is_direct_message detection", () => {
  test("spaceType DIRECT_MESSAGE → is_direct_message on MESSAGE events", async () => {
    const adapter = makeAdapter();
    const ev = await adapter.receive({
      platform: "google_chat",
      raw: {
        type: "MESSAGE",
        space: { name: "spaces/DM1", spaceType: "DIRECT_MESSAGE" },
        user: { name: "users/123" },
        message: { name: "spaces/DM1/messages/1", text: "hi" },
      },
    });
    expect(ev.is_direct_message).toBe(true);
  });

  test("legacy singleUserBotDm flag also marks a DM", async () => {
    const adapter = makeAdapter();
    const ev = await adapter.receive({
      platform: "google_chat",
      raw: {
        type: "MESSAGE",
        space: { name: "spaces/DM2", singleUserBotDm: true },
        user: { name: "users/123" },
        message: { name: "spaces/DM2/messages/1", text: "hi" },
      },
    });
    expect(ev.is_direct_message).toBe(true);
  });

  test("SPACE messages carry no is_direct_message", async () => {
    const adapter = makeAdapter();
    const ev = await adapter.receive({
      platform: "google_chat",
      raw: {
        type: "MESSAGE",
        space: { name: "spaces/AAA", spaceType: "SPACE" },
        user: { name: "users/123" },
        message: { name: "spaces/AAA/messages/1", text: "hi" },
      },
    });
    expect(ev.is_direct_message).toBeUndefined();
  });

  test("interaction (CARD_CLICKED) and system (ADDED_TO_SPACE) DM events carry the flag too", async () => {
    const adapter = makeAdapter();
    const click = await adapter.receive({
      platform: "google_chat",
      raw: {
        type: "CARD_CLICKED",
        eventTime: "2026-01-01T00:00:04Z",
        space: { name: "spaces/DM1", spaceType: "DIRECT_MESSAGE" },
        user: { name: "users/123" },
        message: { name: "spaces/DM1/messages/9" },
        common: {
          invokedFunction: "approve",
          parameters: { action_id: "approve:ap-1", value: "conv-1" },
        },
      },
    });
    expect(click.kind).toBe("interaction");
    expect(click.is_direct_message).toBe(true);

    const added = await adapter.receive({
      platform: "google_chat",
      raw: {
        type: "ADDED_TO_SPACE",
        eventTime: "2026-01-01T00:00:05Z",
        space: { name: "spaces/DM1", spaceType: "DIRECT_MESSAGE" },
        user: { name: "users/123" },
      },
    });
    expect(added.kind).toBe("system");
    expect(added.system_event).toBe("added_to_space");
    expect(added.is_direct_message).toBe(true);
  });
});

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
    // The dialog reflects the seeded row's fields.
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
    // Probe resistance: no elicitation content leaks.
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
