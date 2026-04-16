// Google Chat adapter test — mock token + messages endpoints.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { GoogleChatAdapter } from "../adapter.ts";

interface Hit {
  path: string;
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
    hits.push({
      path: c.req.path,
      body: await c.req.text(),
      authorization: c.req.header("authorization") ?? "",
    });
    return c.json({ name: `spaces/AAA/messages/${hits.length}` });
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
    expect(hits[1]?.body).toContain("cardsV2");
    expect(hits[1]?.body).toContain("approve:ap-1");
  });
});
