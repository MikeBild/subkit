// Negative-coverage test for the C-1 fix in
// SlackAdapter.handleSyncInteraction: an `open_elicit:<id>` click from
// workspace W_A carrying an elicitation_id that exists in tenant T_B
// must NOT open a modal exposing T_B's elicitation contents.
//
// The fix scopes the elicitation lookup by workspace tenant; the test
// confirms the cross-tenant case takes the "not found" branch and does
// not call `views.open`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import {
  type ConversationTestCtx,
  createConversationTestCtx,
} from "../../../conversations/tests/setup.ts";
import {
  chatWorkspaces,
  conversationElicitations,
  conversations,
  conversationToolCalls,
  tenants,
  users,
} from "../../../db/schema/index.ts";
import { createDeterministicHexFactory } from "../../../test-helpers/determinism/ids.ts";
import { SlackAdapter } from "../adapter.ts";

const nextHex = createDeterministicHexFactory(0xa9c155);
const detBytes = (n: number): Buffer => Buffer.from(nextHex(n), "hex");

interface Recorded {
  path: string;
  body: string;
}

let ctx: ConversationTestCtx;
let baseUrl = "";
let server: ReturnType<typeof serve> | null = null;
const recorded: Recorded[] = [];

beforeAll(async () => {
  ctx = await createConversationTestCtx("handle-sync-xtenant");

  const app = new Hono();
  app.post("*", async (c) => {
    const body = await c.req.text();
    recorded.push({ path: c.req.path, body });
    return c.json({ ok: true });
  });
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
      baseUrl = `http://127.0.0.1:${info.port}/`;
      resolve();
    });
  });
});

afterAll(async () => {
  if (server) await new Promise<void>((r) => server?.close(() => r()));
  await ctx.cleanup();
});

describe("SlackAdapter.handleSyncInteraction — cross-tenant elicitation defense (C-1)", () => {
  test("an open_elicit referencing an elicitation in a foreign tenant is dropped without views.open", async () => {
    // Workspace A — under our test tenant.
    await ctx.testDb.db.insert(chatWorkspaces).values({
      tenant_id: ctx.tenant_id,
      platform: "slack",
      workspace_id: "T_LOCAL",
      bot_ciphertext: detBytes(1),
      bot_iv: detBytes(1),
      bot_auth_tag: detBytes(1),
    });

    // Create a SECOND tenant and an elicitation row inside it. This
    // mimics the attack: an elicitation_id from another tenant.
    const [foreignTenant] = await ctx.testDb.db
      .insert(tenants)
      .values({ slug: "t-xtenant-foreign", display_name: "Foreign" })
      .returning();
    if (!foreignTenant) throw new Error("seed foreign tenant");
    const [foreignUser] = await ctx.testDb.db
      .insert(users)
      .values({ tenant_id: foreignTenant.id, email: "foreign@x.test", role: "admin" })
      .returning();
    if (!foreignUser) throw new Error("seed foreign user");
    const [foreignConv] = await ctx.testDb.db
      .insert(conversations)
      .values({
        tenant_id: foreignTenant.id,
        owner_id: foreignUser.id,
        status: "awaiting_input",
        draft: {},
      })
      .returning();
    if (!foreignConv) throw new Error("seed foreign conversation");
    const [foreignTc] = await ctx.testDb.db
      .insert(conversationToolCalls)
      .values({
        tenant_id: foreignTenant.id,
        conversation_id: foreignConv.id,
        tool: "ask_user_text",
        input: { summary: "FOREIGN-SECRET-PROMPT", fields: [] },
        approval_required: true,
      })
      .returning();
    if (!foreignTc) throw new Error("seed foreign tool_call");
    const [foreignElic] = await ctx.testDb.db
      .insert(conversationElicitations)
      .values({
        tenant_id: foreignTenant.id,
        conversation_id: foreignConv.id,
        tool_call_id: foreignTc.id,
        tool_name: "ask_user_text",
        summary: "FOREIGN-SECRET-PROMPT",
        input: { summary: "FOREIGN-SECRET-PROMPT", fields: [] },
        status: "pending",
      })
      .returning();
    if (!foreignElic) throw new Error("seed foreign elicitation");

    // Build an adapter that talks to the recording mock instead of Slack.
    const adapter = new SlackAdapter({
      signingSecret: "x",
      botToken: "xoxb-test",
      slackApiUrl: baseUrl,
    });

    // Drive `handleSyncInteraction` directly — the event was received
    // by workspace T_LOCAL but carries the foreign tenant's
    // elicitation_id. The pre-fix code would 200 OK + `views.open`
    // with the foreign elicitation; the fix returns handled with NO
    // Slack API call.
    const before = recorded.length;
    const outcome = await adapter.handleSyncInteraction({
      event: {
        platform: "slack",
        workspace_id: "T_LOCAL",
        channel_id: "C_X",
        user_id: "U_ATTACKER",
        kind: "interaction",
        interaction: {
          action_id: `open_elicit:${foreignElic.id}`,
          value: JSON.stringify({ c: foreignConv.id, o: {} }),
        },
        raw: { trigger_id: "tg-xtenant-attack" },
      },
      db: ctx.testDb.db,
    });

    expect(outcome.handled).toBe(true);
    // No Slack API call was made — the elicitation lookup was scoped
    // by the workspace's tenant and missed.
    expect(recorded.length).toBe(before);
    // Specifically, no /views.open was made.
    expect(recorded.find((r) => r.path.includes("views.open"))).toBeUndefined();
  });
});
