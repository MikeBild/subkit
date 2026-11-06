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
  users,
} from "../../../db/schema/index.ts";
import { builtinRoleId } from "../../../rbac/roles.ts";
import { createDeterministicHexFactory } from "../../../test-helpers/determinism/ids.ts";
import { seedTenant } from "../../../test-helpers/seed.ts";
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
    await ctx.testDb.db.insert(chatWorkspaces).values({
      tenant_id: ctx.tenant_id,
      platform: "slack",
      workspace_id: "T_LOCAL",
      bot_ciphertext: detBytes(1),
      bot_iv: detBytes(1),
      bot_auth_tag: detBytes(1),
    });

    const foreignTenant = await seedTenant(ctx.testDb.db, {
      slug: "t-xtenant-foreign",
      display_name: "Foreign",
    });
    const [foreignUser] = await ctx.testDb.db
      .insert(users)
      .values({
        tenant_id: foreignTenant.id,
        email: "foreign@x.test",
        role_id: await builtinRoleId(ctx.testDb.db, "admin"),
      })
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

    const adapter = new SlackAdapter({
      signingSecret: "x",
      botToken: "xoxb-test",
      slackApiUrl: baseUrl,
    });

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
    expect(recorded.length).toBe(before);
    expect(recorded.find((r) => r.path.includes("views.open"))).toBeUndefined();
  });
});
