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

  // ---------------------------------------------------------------------
  // receive() — normalization for the new inbound shapes added in
  // Checkpoint 1 and 3.
  // ---------------------------------------------------------------------
  describe("receive() — DM (`message.im`)", () => {
    test("normalizes a real DM into a `mention`-kind event", async () => {
      const adapter = new SlackAdapter({ signingSecret: "x", botToken: "xoxb-test" });
      const ev = await adapter.receive({
        platform: "slack",
        raw: {
          type: "event_callback",
          team_id: "T_DM",
          event_id: "Ev_DM_1",
          event: {
            type: "message",
            channel_type: "im",
            channel: "D123",
            user: "U_ALICE",
            ts: "1700000000.000100",
            text: "hello bot",
          },
        },
      });
      expect(ev.kind).toBe("mention");
      expect(ev.channel_id).toBe("D123");
      expect(ev.user_id).toBe("U_ALICE");
      expect(ev.thread_id).toBe("1700000000.000100"); // falls back to ts
      expect(ev.event_key).toBe("Ev_DM_1");
      expect(ev.text).toBe("hello bot");
    });

    test("suppresses bot echo: bot_id, subtype, app_id all drop the event", async () => {
      const adapter = new SlackAdapter({ signingSecret: "x", botToken: "xoxb-test" });
      const botEcho = adapter.receive({
        platform: "slack",
        raw: {
          type: "event_callback",
          team_id: "T_DM",
          event_id: "Ev_DM_2",
          event: {
            type: "message",
            channel_type: "im",
            channel: "D123",
            bot_id: "B_BOT",
            ts: "1700000000.000200",
            text: "self-emitted reply",
          },
        },
      });
      await expect(botEcho).rejects.toThrow(/unrecognized event shape/);

      const subtypeEcho = adapter.receive({
        platform: "slack",
        raw: {
          type: "event_callback",
          team_id: "T_DM",
          event_id: "Ev_DM_3",
          event: {
            type: "message",
            channel_type: "im",
            channel: "D123",
            subtype: "message_changed",
            ts: "1700000000.000300",
          },
        },
      });
      await expect(subtypeEcho).rejects.toThrow(/unrecognized event shape/);
    });
  });

  describe("receive() — interactions", () => {
    test("block_actions multi:submit reassembles selected checkboxes into form_values.values", async () => {
      const adapter = new SlackAdapter({ signingSecret: "x", botToken: "xoxb-test" });
      const ev = await adapter.receive({
        platform: "slack",
        raw: {
          type: "block_actions",
          team_id: "T1",
          trigger_id: "tg-1",
          channel: { id: "C1" },
          user: { id: "U_ALICE" },
          message: { ts: "1700.000", thread_ts: "1700.000" },
          actions: [
            {
              action_id: "elicit:elic-1:multi:submit",
              value: JSON.stringify({ c: "conv-1", o: { kind: "multi" } }),
            },
          ],
          state: {
            values: {
              "subkit_elicit_opts:elic-1": {
                "elicit:elic-1:multi:select": {
                  type: "checkboxes",
                  selected_options: [{ value: "a" }, { value: "c" }],
                },
              },
            },
          },
        },
      });
      expect(ev.kind).toBe("interaction");
      expect(ev.interaction?.action_id).toBe("elicit:elic-1:multi:submit");
      expect(ev.interaction?.form_values).toEqual({ values: ["a", "c"] });
    });

    test("view_submission flattens state.values into a form_values dict and carries private_metadata", async () => {
      const adapter = new SlackAdapter({ signingSecret: "x", botToken: "xoxb-test" });
      const privateMeta = JSON.stringify({ c: "conv-1", e: "elic-1", k: "form" });
      const ev = await adapter.receive({
        platform: "slack",
        raw: {
          type: "view_submission",
          team_id: "T1",
          channel: { id: "C1" },
          user: { id: "U_ALICE" },
          view: {
            id: "V_123",
            private_metadata: privateMeta,
            state: {
              values: {
                "field:title": { "el:title": { type: "plain_text_input", value: "Q3 plan" } },
                "field:tier": {
                  "el:tier": { type: "static_select", selected_option: { value: "pro" } },
                },
                "field:due": { "el:due": { type: "datepicker", selected_date: "2026-09-30" } },
              },
            },
          },
        },
      });
      expect(ev.interaction?.action_id).toBe("view_submission");
      expect(ev.interaction?.value).toBe(privateMeta);
      expect(ev.interaction?.form_values).toEqual({
        title: "Q3 plan",
        tier: "pro",
        due: "2026-09-30",
      });
      expect(ev.event_key).toBe("V_123");
    });
  });
});
