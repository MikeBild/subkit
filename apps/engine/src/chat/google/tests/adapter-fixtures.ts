import { afterAll, beforeAll } from "bun:test";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import {
  type ConversationTestCtx,
  createConversationTestCtx,
} from "../../../conversations/tests/setup.ts";
import { createDeterministicHexFactory } from "../../../test-helpers/determinism/ids.ts";
import { GoogleChatAdapter } from "../adapter.ts";

let nextHex = createDeterministicHexFactory(0x900c4d);

export const detBytes = (n: number): Buffer => Buffer.from(nextHex(n), "hex");

interface Hit {
  path: string;
  query: string;
  method: string;
  body: string;
  authorization: string;
}

export let hits: Hit[] = [];

export let baseUrl = "";

let server: ReturnType<typeof serve> | null = null;

export let tokenCalls = 0;

export let ctx: ConversationTestCtx;

export const makeAdapter = (): GoogleChatAdapter =>
  new GoogleChatAdapter({
    clientEmail: "bot@svc.gserviceaccount.com",
    staticAssertion: "stub-assertion",
    tokenEndpoint: `${baseUrl}/oauth2/token`,
    baseUrl,
  });

export function setupGoogleChatAdapter(): void {
  nextHex = createDeterministicHexFactory(0x900c4d);
  hits = [];
  tokenCalls = 0;
  server = null;
  baseUrl = "";
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
      server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
        baseUrl = `http://127.0.0.1:${info.port}`;
        resolve();
      });
    });
  });
  afterAll(async () => {
    if (server) await new Promise<void>((r) => server?.close(() => r()));
    await ctx.cleanup();
  });
}
