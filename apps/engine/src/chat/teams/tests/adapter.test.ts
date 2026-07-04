// Teams adapter test — uses a mock Hono server for both the token
// endpoint and the Bot Framework activities endpoint.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { TeamsAdapter } from "../adapter.ts";

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
    return c.json({ access_token: `tok-${tokenCalls}`, expires_in: 3600 });
  });
  app.post("/v3/conversations/:id/activities", async (c) => {
    hits.push({
      path: c.req.path,
      body: await c.req.text(),
      authorization: c.req.header("authorization") ?? "",
    });
    return c.json({ id: `activity-${hits.length}` });
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

describe("teams adapter", () => {
  test("caches the client credentials token across outbound calls", async () => {
    const adapter = new TeamsAdapter({
      clientId: "cid",
      clientSecret: "csecret",
      tokenEndpoint: `${baseUrl}/oauth2/token`,
      serviceUrl: baseUrl,
    });

    await adapter.send({
      tenant_id: "t",
      workspace_id: "w",
      channel_id: "19:convo",
      kind: "message",
      text: "hi",
    });
    await adapter.sendApproval({
      tenant_id: "t",
      workspace_id: "w",
      channel_id: "19:convo",
      conversation_id: "conv-1",
      approval_id: "ap-1",
      summary: "commit draft",
    });

    expect(tokenCalls).toBe(1);
    expect(hits.length).toBe(2);
    expect(hits[0]?.authorization).toBe("Bearer tok-1");
    expect(hits[1]?.body).toContain("AdaptiveCard");
    expect(hits[1]?.body).toContain("approve:ap-1");
  });
});
