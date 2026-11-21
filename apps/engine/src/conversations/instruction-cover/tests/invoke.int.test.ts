import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "@hono/zod-openapi";
import { and, eq, sql } from "drizzle-orm";
import { AuditAction } from "../../../audit/types.ts";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import type { Db } from "../../../db/client.ts";
import {
  auditLog,
  conversationElicitations,
  conversationMessages,
  conversations,
  conversationToolCalls,
  sessions,
  toolApprovals,
  users,
} from "../../../db/schema/index.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { createLlmTestCtx, type LlmTestCtx } from "../../../llm/tests/setup.ts";
import { builtinRoleId } from "../../../rbac/roles.ts";
import { freshSignals } from "../../tests/turn-signals.ts";
import type { ConversationTool, ToolContext } from "../../tools/index.ts";
import { wrapOne } from "../../tools/sdk-wrap/invoke.ts";
import type { TurnEvent } from "../../types.ts";
import { toolCallPolicyView } from "../view.ts";

let ctx: LlmTestCtx;
let principal: ResolvedPrincipal;
const executed: Array<Record<string, unknown>> = [];

const connectorWrite: ConversationTool = {
  name: "call_connector",
  description: "Calls a saved connector.",
  category: "tenant_read",
  inputSchema: z.object({
    connector_id: z.string(),
    method: z.string(),
    path: z.string(),
    body: z.unknown().optional(),
  }),
  async execute(_ctx, args) {
    executed.push(args as Record<string, unknown>);
    return { ok: true, data: { status: 202 } };
  },
};

function sendArgs(to: string) {
  return {
    connector_id: "mail",
    method: "POST",
    path: "/v1/messages/send",
    body: { to, subject: "Verspätung", text: "Ich komme später." },
  };
}

async function conversationWith(text: string): Promise<string> {
  const db = ctx.testDb.db;
  const [row] = await db
    .insert(conversations)
    .values({ tenant_id: ctx.tenant_id, status: "active", owner_id: principal.id })
    .returning({ id: conversations.id });
  if (!row) throw new Error("conversation fixture missing");
  await db.insert(conversationMessages).values({
    tenant_id: ctx.tenant_id,
    conversation_id: row.id,
    role: "user",
    content: { text },
  });
  return row.id;
}

async function invoke(
  conversation_id: string,
  askBeforeWriting: boolean,
  args: Record<string, unknown>,
) {
  const db = ctx.testDb.db as unknown as Db;
  const toolCtx: ToolContext = {
    db,
    tenant_id: ctx.tenant_id,
    conversation_id,
    actor_id: principal.id,
    principal,
    surface: "web",
    ...(askBeforeWriting ? { ask_before_writing: true } : {}),
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({
      tenant_id: ctx.tenant_id,
      actor_id: principal.id,
      actor_type: "user",
      db,
    }),
    getDraft: () => ({ workflow: { name: "", steps: [] } }),
    setDraft: async () => {},
  };
  const events: TurnEvent[] = [];
  const wrapped = wrapOne(connectorWrite, toolCtx, freshSignals(), events, db, {});
  if (!wrapped.execute) throw new Error("wrapped tool has no execute");
  const output = await wrapped.execute(args, { toolCallId: "t", messages: [], context: {} });
  const calls = await ctx.testDb.db
    .select()
    .from(conversationToolCalls)
    .where(eq(conversationToolCalls.conversation_id, conversation_id));
  return { output: output as { ok: boolean; data: Record<string, unknown> }, events, calls };
}

const REQUEST = "Schick bitte eine Mail an anna@firma.de, dass ich später komme.";
const QUOTE = "Schick bitte eine Mail an anna@firma.de";

beforeAll(async () => {
  ctx = await createLlmTestCtx("instruction-cover-invoke");
  const [row] = await ctx.testDb.db
    .insert(users)
    .values({
      tenant_id: ctx.tenant_id,
      email: "person@example.test",
      role_id: await builtinRoleId(ctx.testDb.db, "member"),
    })
    .returning({ id: users.id });
  if (!row) throw new Error("user fixture missing");
  const [session] = await ctx.testDb.db
    .insert(sessions)
    .values({
      tenant_id: ctx.tenant_id,
      user_id: row.id,
      expires_at: sql`clock_timestamp() + interval '1 hour'`,
    })
    .returning({ id: sessions.id });
  if (!session) throw new Error("session fixture missing");
  principal = {
    provider: "session",
    auth_source: { kind: "browser_session", session_id: session.id },
    kind: "user",
    id: row.id,
    tenant_id: ctx.tenant_id,
    roles: ["member"],
  };
}, 120_000);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, 30_000);

describe("a connector write through the wrapped tool", () => {
  test("in auto the requested send runs once without a card and is justified on record", async () => {
    executed.length = 0;
    const conversation_id = await conversationWith(REQUEST);
    const first = await invoke(conversation_id, false, {
      ...sendArgs("anna@firma.de"),
      __because: QUOTE,
    });
    expect(first.output.ok).toBe(true);
    expect(executed).toEqual([sendArgs("anna@firma.de")]);
    expect(first.calls).toHaveLength(1);
    expect(first.calls[0]?.input).toEqual(sendArgs("anna@firma.de"));
    expect(toolCallPolicyView(first.calls[0]?.confirmation_data)).toMatchObject({
      ran_without_asking: true,
      rule: "user_instruction",
      because: { quote: QUOTE },
      bound_action: { verb: "send", account: "mail", recipients: ["anna@firma.de"] },
    });
    expect(
      first.events.some(
        (event) => event.type === "data_part" && event.data_type === "ran_without_asking",
      ),
    ).toBe(true);
    expect(first.events.some((event) => event.type === "elicit_request")).toBe(false);
    const skipped = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.resource_id, conversation_id),
          eq(auditLog.action, AuditAction.TOOL_POLICY_CONFIRMATION_SKIPPED),
        ),
      );
    expect(skipped.map((entry) => entry.reason)).toEqual(["user_instruction"]);

    const second = await invoke(conversation_id, false, {
      ...sendArgs("anna@firma.de"),
      __because: QUOTE,
    });
    expect(second.output.ok).toBe(false);
    expect(second.output.data.status).toBe("awaiting_confirmation");
    expect(executed).toHaveLength(1);
  });

  test("another recipient pauses with a card that binds the exact action", async () => {
    executed.length = 0;
    const conversation_id = await conversationWith(REQUEST);
    const result = await invoke(conversation_id, false, {
      ...sendArgs("bob@firma.de"),
      __because: QUOTE,
    });
    expect(result.output.ok).toBe(false);
    expect(result.output.data.status).toBe("awaiting_confirmation");
    expect(executed).toEqual([]);
    const [card] = await ctx.testDb.db
      .select()
      .from(conversationElicitations)
      .where(eq(conversationElicitations.conversation_id, conversation_id));
    expect(card?.status).toBe("pending");
    expect(card?.input).toMatchObject({
      ask_reason: "recipient_not_named",
      bound_action: {
        verb: "send",
        target: "POST /v1/messages/send",
        account: "mail",
        recipients: ["bob@firma.de"],
      },
      commit_intent: { kind: "execute_confirmed_tool_call" },
    });
    const approvals = await ctx.testDb.db
      .select()
      .from(toolApprovals)
      .where(eq(toolApprovals.tenant_id, ctx.tenant_id));
    const bound = approvals.filter((approval) => approval.consumed_at === null);
    expect(bound.length).toBeGreaterThanOrEqual(1);
    expect(bound.every((approval) => approval.tool === "call_connector")).toBe(true);
    expect(toolCallPolicyView(result.calls[0]?.confirmation_data)).toMatchObject({
      ran_without_asking: false,
      because: null,
      ask_reason: "recipient_not_named",
    });
  });

  test("asking before writing and a missing quote keep the card", async () => {
    executed.length = 0;
    const asking = await conversationWith(REQUEST);
    const inAsk = await invoke(asking, true, { ...sendArgs("anna@firma.de"), __because: QUOTE });
    expect(inAsk.output.data.status).toBe("awaiting_confirmation");
    const silent = await conversationWith(REQUEST);
    const noQuote = await invoke(silent, false, sendArgs("anna@firma.de"));
    expect(noQuote.output.data.status).toBe("awaiting_confirmation");
    expect(toolCallPolicyView(noQuote.calls[0]?.confirmation_data)?.ask_reason).toBe("no_quote");
    expect(executed).toEqual([]);
  });

  test("a read is not slowed down or recorded as an effect", async () => {
    executed.length = 0;
    const conversation_id = await conversationWith("Zeig mir die letzten Nachrichten");
    const result = await invoke(conversation_id, false, {
      connector_id: "mail",
      method: "GET",
      path: "/v1/messages",
    });
    expect(result.output.ok).toBe(true);
    expect(executed).toHaveLength(1);
    expect(result.calls[0]?.confirmation_data ?? null).toBeNull();
  });
});
