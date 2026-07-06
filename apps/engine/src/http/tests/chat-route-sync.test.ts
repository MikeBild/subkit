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

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { ChatAdapter } from "../../chat/adapter.ts";
import { ChatAdapterRegistry } from "../../chat/registry.ts";
import type { ChatSyncResult } from "../../chat/sync-turn.ts";
import type { ChatEvent, VerifiedEvent } from "../../chat/types.ts";
import { getConfig, loadConfig } from "../../config/loader.ts";
import type { Db } from "../../db/client.ts";
import type { AppEnv } from "../openapi.ts";
import { registerChatRoutes } from "../routes/chat.ts";

/** The F2 branch reads `getConfig().platform.googlechat.sync_turn_timeout_ms`.
 *  Production always has config loaded at boot; this bootstraps it
 *  idempotently for the bare route test. */
async function ensureConfigLoaded(): Promise<void> {
  try {
    getConfig();
    return;
  } catch {
    // not yet loaded — fall through.
  }
  const dir = mkdtempSync(join(tmpdir(), "sk-cfg-chat-sync-test-"));
  await loadConfig({
    env: { DATABASE_URL: "postgres://placeholder/http-test", NODE_ENV: "test" },
    configPathOverride: join(dir, "subkit.config.json"),
  });
}

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

// ── F2: synchronous Google-Chat response path ───────────────────────────────
//
// For a Google-Chat MESSAGE (mention / slash_command), the route runs the
// turn inline via `runChatTurnSync` and returns its verdict:
//
//   { deliver:"sync", text } → HTTP body { text }; nothing enqueued.
//   { deliver:"acked" }      → HTTP body { ok:true }; nothing enqueued
//                              (awaiting_input card sent inline, or the
//                              turn was detached on timeout).
//   { deliver:"defer" }      → route falls through to enqueue + { ok:true }
//                              (first-DM: worker owns the whole event).
//
// The seam (`deps.runSyncTurn`) is faked so these arms are exercised
// without a live DB or LLM turn. `runChatTurnSync`'s own no-double-send
// guarantee is proven in chat/tests/sync-turn.test.ts.

const MENTION_EVENT: ChatEvent = {
  platform: "google_chat",
  workspace_id: WORKSPACE_ID,
  channel_id: WORKSPACE_ID,
  thread_id: "spaces/AAAA-test-space/threads/T1",
  user_id: "users/1234567890",
  kind: "mention",
  text: "gib mir das wetter von übermorgen",
  event_key: "evt-f2-message-1",
  raw: {},
};

function makeSyncHarness(opts: {
  syncResult: ChatSyncResult;
  /** Omit for a mention; pass "interaction" to prove the F2 branch is
   *  skipped for non-MESSAGE events. */
  eventKind?: ChatEvent["kind"];
}) {
  const enqueued: Array<{ event: ChatEvent }> = [];
  const syncTurnCalls: Array<{ event: ChatEvent; timeoutMs: number }> = [];

  const event: ChatEvent = { ...MENTION_EVENT, kind: opts.eventKind ?? "mention" };

  const adapter: ChatAdapter = {
    platform: "google_chat",
    verify: async (req: Request): Promise<VerifiedEvent | null> => ({
      platform: "google_chat",
      raw: await req.json(),
    }),
    receive: async (): Promise<ChatEvent> => event,
    send: async () => ({ platform_message_id: "msg-1" }),
    update: async () => {},
    sendApproval: async () => ({ platform_message_id: "msg-2" }),
  };

  const registry = new ChatAdapterRegistry();
  registry.register(
    { tenant_id: TENANT_ID, platform: "google_chat", workspace_id: WORKSPACE_ID },
    adapter,
  );

  const app = new OpenAPIHono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", {} as Db);
    await next();
  });
  registerChatRoutes(app, {
    registry,
    enqueue: async (job) => {
      enqueued.push(job);
    },
    runSyncTurn: async (args) => {
      syncTurnCalls.push({ event: args.event, timeoutMs: args.timeoutMs });
      return opts.syncResult;
    },
  });

  const post = () =>
    app.request("/v1/chat/google/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "MESSAGE" }),
    });

  return { post, enqueued, syncTurnCalls };
}

describe("POST /v1/chat/google/events — F2 synchronous MESSAGE path", () => {
  beforeAll(async () => {
    await ensureConfigLoaded();
  });

  test("fast normal reply → body { text }, nothing enqueued", async () => {
    const h = makeSyncHarness({ syncResult: { deliver: "sync", text: "*20°C* and sunny" } });

    const res = await h.post();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ text: "*20°C* and sunny" });
    // Single delivery via the HTTP body — the queue is never touched.
    expect(h.enqueued.length).toBe(0);
    expect(h.syncTurnCalls.length).toBe(1);
    expect(h.syncTurnCalls[0]?.event.kind).toBe("mention");
    // The route threaded the configured bounded timeout.
    expect(h.syncTurnCalls[0]?.timeoutMs).toBeGreaterThan(0);
  });

  test("awaiting_input / detached-timeout → body { ok:true }, nothing enqueued", async () => {
    const h = makeSyncHarness({ syncResult: { deliver: "acked" } });

    const res = await h.post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // Card/detached delivery is owned by the dispatcher — NOT the queue.
    expect(h.enqueued.length).toBe(0);
    expect(h.syncTurnCalls.length).toBe(1);
  });

  test("defer (no workspace) → falls through to enqueue once + { ok:true }", async () => {
    const h = makeSyncHarness({ syncResult: { deliver: "defer" } });

    const res = await h.post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // The worker owns the whole event on the defer path.
    expect(h.enqueued.length).toBe(1);
    expect(h.enqueued[0]?.event.kind).toBe("mention");
    expect(h.syncTurnCalls.length).toBe(1);
  });

  test("no-double-send: sync arm delivers via body AND enqueues nothing", async () => {
    // Both delivery owners can never fire for the same event: on the sync
    // arm the body carries the reply and the queue is untouched (0), so
    // the queue worker never runs a second turn / second send.
    const h = makeSyncHarness({ syncResult: { deliver: "sync", text: "done" } });
    await h.post();
    expect(h.enqueued.length).toBe(0);
  });

  test("interaction MESSAGE is NOT hijacked by the sync path (only mention/slash_command)", async () => {
    // An `interaction` kind must skip runChatTurnSync entirely and take
    // the existing enqueue path (kept for elicitation button clicks).
    const h = makeSyncHarness({
      syncResult: { deliver: "sync", text: "should not be used" },
      eventKind: "interaction",
    });

    const res = await h.post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.syncTurnCalls.length).toBe(0);
    expect(h.enqueued.length).toBe(1);
  });
});
