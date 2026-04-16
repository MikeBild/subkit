// Slack adapter outbound HTTP test. A tiny Hono server stands in
// for api.slack.com and records every call the WebClient makes.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { SlackAdapter } from "../adapter.ts";

interface Recorded {
  path: string;
  body: string;
}

const recorded: Recorded[] = [];
let baseUrl = "";
let server: ReturnType<typeof serve> | null = null;

beforeAll(async () => {
  const app = new Hono();
  app.post("*", async (c) => {
    const body = await c.req.text();
    recorded.push({ path: c.req.path, body });
    return c.json({ ok: true, ts: "1700000000.000100", message_ts: "1700000000.000200" });
  });
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      baseUrl = `http://127.0.0.1:${info.port}/`;
      resolve();
    });
  });
});

afterAll(async () => {
  if (server) await new Promise<void>((r) => server?.close(() => r()));
});

describe("slack adapter", () => {
  test("send + update + sendApproval all hit the mocked API", async () => {
    const adapter = new SlackAdapter({
      signingSecret: "x",
      botToken: "xoxb-test",
      slackApiUrl: baseUrl,
    });

    const sent = await adapter.send({
      tenant_id: "t1",
      workspace_id: "T1",
      channel_id: "C1",
      kind: "message",
      text: "hello world",
    });
    expect(sent.platform_message_id).toBe("1700000000.000100");

    await adapter.update(
      {
        tenant_id: "t1",
        workspace_id: "T1",
        channel_id: "C1",
        kind: "message",
        text: "edited",
      },
      sent.platform_message_id,
    );

    const ap = await adapter.sendApproval({
      tenant_id: "t1",
      workspace_id: "T1",
      channel_id: "C1",
      conversation_id: "conv-1",
      approval_id: "ap-1",
      summary: "commit 1-step workflow",
    });
    expect(ap.platform_message_id).toBe("1700000000.000100");

    expect(recorded.length).toBe(3);
    const paths = recorded.map((r) => r.path);
    expect(paths.some((p) => p.includes("chat.postMessage"))).toBe(true);
    expect(paths.some((p) => p.includes("chat.update"))).toBe(true);
    const approvalBody = decodeURIComponent(recorded[2]?.body ?? "");
    expect(approvalBody).toContain("approve:ap-1");
    expect(approvalBody).toContain("reject:ap-1");
  });
});
