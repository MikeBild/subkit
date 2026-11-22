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

async function ensureConfigLoaded(): Promise<void> {
  try {
    getConfig();
    return;
  } catch {}
  const dir = mkdtempSync(join(tmpdir(), "subkit-cfg-chat-sync-test-"));
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

function makeHarness(opts: { sync?: () => Promise<SyncResult> }) {
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

  const post = (headers: Record<string, string> = {}) =>
    app.request("/v1/chat/google/events", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
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

  test("verified synthetic canary classification reaches the queued event", async () => {
    const h = makeHarness({ sync: async () => ({ handled: false }) });
    const res = await h.post({ "x-subkit-traffic-class": "synthetic" });
    expect(res.status).toBe(200);
    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0]?.event.traffic_class).toBe("synthetic");
    expect(h.enqueued[0]?.event.raw).toEqual({});
  });
});

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

function makeSyncHarness(opts: { syncResult: ChatSyncResult; eventKind?: ChatEvent["kind"] }) {
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
    expect(h.enqueued.length).toBe(0);
    expect(h.syncTurnCalls.length).toBe(1);
    expect(h.syncTurnCalls[0]?.event.kind).toBe("mention");
    expect(h.syncTurnCalls[0]?.timeoutMs).toBeGreaterThan(0);
  });

  test("awaiting_input / detached-timeout → body { ok:true }, nothing enqueued", async () => {
    const h = makeSyncHarness({ syncResult: { deliver: "acked" } });

    const res = await h.post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.enqueued.length).toBe(0);
    expect(h.syncTurnCalls.length).toBe(1);
  });

  test("defer (no workspace) → falls through to enqueue once + { ok:true }", async () => {
    const h = makeSyncHarness({ syncResult: { deliver: "defer" } });

    const res = await h.post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.enqueued.length).toBe(1);
    expect(h.enqueued[0]?.event.kind).toBe("mention");
    expect(h.syncTurnCalls.length).toBe(1);
  });

  test("no-double-send: sync arm delivers via body AND enqueues nothing", async () => {
    const h = makeSyncHarness({ syncResult: { deliver: "sync", text: "done" } });
    await h.post();
    expect(h.enqueued.length).toBe(0);
  });

  test("interaction MESSAGE is NOT hijacked by the sync path (only mention/slash_command)", async () => {
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
