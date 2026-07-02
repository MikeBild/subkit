// Google Chat adapter test — mock token + messages endpoints.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { GoogleChatAdapter } from "../adapter.ts";

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

beforeAll(async () => {
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
