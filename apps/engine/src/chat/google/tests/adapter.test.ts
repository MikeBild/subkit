import { describe, expect, test } from "bun:test";
import { GoogleChatAdapter } from "../adapter.ts";
import {
  baseUrl,
  hits,
  makeAdapter,
  setupGoogleChatAdapter,
  tokenCalls,
} from "./adapter-fixtures.ts";

setupGoogleChatAdapter();

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
    expect(modern.event_key).toContain("2026-01-01T00:00:00Z");

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
