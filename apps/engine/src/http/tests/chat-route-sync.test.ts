// The chat ingest route's synchronous fast path (`handleSyncInteraction`)
// carries a widened return contract:
//
//   { handled: false }                          → enqueue + ack {ok:true}
//   { handled: true }                           → respond {ok:true}, NO enqueue
//                                                 (Slack legacy shape)
//   { handled: true, response, enqueue: false } → respond with `response`
//                                                 verbatim, NO enqueue
//                                                 (Google OPEN_DIALOG: the
//                                                 HTTP body IS the dialog)
//   { handled: true, response, enqueue: true }  → respond with `response`
//                                                 AND enqueue exactly once
//                                                 (Google dialog submit:
//                                                 sync close-ack + async
//                                                 LLM resolution)
//
// These tests drive `registerChatRoutes` on a bare Hono app with a fake
// adapter + injected `enqueue`, asserting the HTTP body and the enqueue
// count for each arm. No real DB or platform verification involved —
// the fake adapter's verify() always succeeds and the sync handler
// never touches `db`, so a stub object satisfies the context.

import { describe, expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { ChatAdapter } from "../../chat/adapter.ts";
import { ChatAdapterRegistry } from "../../chat/registry.ts";
import type { ChatEvent, VerifiedEvent } from "../../chat/types.ts";
import type { Db } from "../../db/client.ts";
import type { AppEnv } from "../openapi.ts";
import { registerChatRoutes } from "../routes/chat.ts";

const TENANT_ID = "00000000-0000-4000-8000-00000000c4a7";
const WORKSPACE_ID = "spaces/AAAA-test-space";

const INTERACTION_EVENT: ChatEvent = {
  platform: "google_chat",
  workspace_id: WORKSPACE_ID,
  channel_id: WORKSPACE_ID,
  user_id: "users/1234567890",
  kind: "interaction",
  interaction: { action_id: "open_elicit:el-1" },
  event_key: "evt-sync-contract-1",
  raw: {},
};

type SyncResult = { handled: boolean; response?: unknown; enqueue?: boolean };

function makeHarness(opts: {
  /** Omit entirely to build an adapter WITHOUT handleSyncInteraction. */
  sync?: () => Promise<SyncResult>;
}) {
  const enqueued: Array<{ event: ChatEvent }> = [];
  const syncCalls: Array<{ event: ChatEvent }> = [];

  const adapter: ChatAdapter = {
    platform: "google_chat",
    verify: async (req: Request): Promise<VerifiedEvent | null> => ({
      platform: "google_chat",
      raw: await req.json(),
    }),
    receive: async (): Promise<ChatEvent> => INTERACTION_EVENT,
    send: async () => ({ platform_message_id: "msg-1" }),
    update: async () => {},
    sendApproval: async () => ({ platform_message_id: "msg-2" }),
    ...(opts.sync
      ? {
          handleSyncInteraction: async (args: { event: ChatEvent; db: Db }) => {
            syncCalls.push({ event: args.event });
            return (opts.sync as () => Promise<SyncResult>)();
          },
        }
      : {}),
  };

  const registry = new ChatAdapterRegistry();
  registry.register(
    { tenant_id: TENANT_ID, platform: "google_chat", workspace_id: WORKSPACE_ID },
    adapter,
  );

  const app = new OpenAPIHono<AppEnv>();
  // The route handler reads `c.get("db")` and only forwards it to the
  // adapter's sync handler (which our fake ignores). A stub is enough —
  // and it must be truthy or the sync fast path is skipped entirely.
  app.use("*", async (c, next) => {
    c.set("db", {} as Db);
    await next();
  });
  registerChatRoutes(app, {
    registry,
    enqueue: async (job) => {
      enqueued.push(job);
    },
  });

  const post = () =>
    app.request("/v1/chat/google/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "CARD_CLICKED" }),
    });

  return { post, enqueued, syncCalls };
}

describe("POST /v1/chat/google/events — handleSyncInteraction contract", () => {
  test("handled + response + enqueue:false → body IS the sync response, nothing enqueued (OPEN_DIALOG)", async () => {
    const dialogResponse = {
      actionResponse: {
        type: "DIALOG",
        dialogAction: { dialog: { body: { sections: [] } } },
      },
    };
    const h = makeHarness({
      sync: async () => ({ handled: true, response: dialogResponse, enqueue: false }),
    });

    const res = await h.post();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual(dialogResponse);
    expect(h.enqueued.length).toBe(0);
    expect(h.syncCalls.length).toBe(1);
  });

  test("handled + response + enqueue:true → body is the ack AND the event is enqueued exactly once (dialog submit)", async () => {
    const closeAck = {
      actionResponse: {
        type: "DIALOG",
        dialogAction: { actionStatus: { statusCode: "OK" } },
      },
    };
    const h = makeHarness({
      sync: async () => ({ handled: true, response: closeAck, enqueue: true }),
    });

    const res = await h.post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(closeAck);
    expect(h.enqueued.length).toBe(1);
    expect(h.enqueued[0]?.event).toEqual(INTERACTION_EVENT);
  });

  test("handled only (Slack legacy shape) → body {ok:true}, nothing enqueued", async () => {
    const h = makeHarness({ sync: async () => ({ handled: true }) });

    const res = await h.post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.enqueued.length).toBe(0);
  });

  test("handled:false → event enqueued once and body {ok:true}", async () => {
    const h = makeHarness({ sync: async () => ({ handled: false }) });

    const res = await h.post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.enqueued.length).toBe(1);
    expect(h.enqueued[0]?.event).toEqual(INTERACTION_EVENT);
    expect(h.syncCalls.length).toBe(1);
  });

  test("adapter without handleSyncInteraction → default path: enqueue once, body {ok:true}", async () => {
    const h = makeHarness({});

    const res = await h.post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.enqueued.length).toBe(1);
    expect(h.syncCalls.length).toBe(0);
  });
});
