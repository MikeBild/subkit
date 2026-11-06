import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { Job, PgBoss } from "pg-boss";
import { actorOf } from "../../audit/actor.ts";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { createElicitation, stageElicitationAnswer } from "../../conversations/elicitations.ts";
import * as svc from "../../conversations/service.ts";
import {
  apiKeys,
  auditLog,
  conversationElicitations,
  mcpTasks,
  systemAccounts,
} from "../../db/schema/index.ts";
import { createEngineCtx, type EngineTestCtx } from "../../execution/tests/setup.ts";
import { generateKey, sha256Hex } from "../../identity/api-key.ts";
import { resetMockProvider } from "../../llm/mock-provider.ts";
import { insertMcpTask } from "../../mcp/tasks/store.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { registerConversationRunTurnHandler } from "../handlers/conversation-run-turn.ts";
import type { ConversationRunTurnJob } from "../queues.ts";
import { ensureTestConfig } from "./test-config.ts";

let ctx: EngineTestCtx;
let run: (jobs: Job<ConversationRunTurnJob>[]) => Promise<void>;

beforeAll(async () => {
  process.env.LLM_PROVIDER = "mock";
  await ensureTestConfig();
  resetMockProvider();
  ctx = await createEngineCtx("conversation-respond-bot");
  const boss = {
    work: async (_name: string, _options: unknown, handler: typeof run) => {
      run = handler;
      return "captured-worker";
    },
  } as unknown as PgBoss;
  await registerConversationRunTurnHandler({ boss, db: ctx.testDb.db });
}, 30_000);

afterAll(async () => {
  if (ctx) await ctx.cleanup();
}, 30_000);

async function systemAccountPrincipal(): Promise<ResolvedPrincipal> {
  const [account] = await ctx.testDb.db
    .insert(systemAccounts)
    .values({
      tenant_id: ctx.tenantId,
      name: "queue-respond-bot",
      role_id: await builtinRoleId(ctx.testDb.db, "member"),
    })
    .returning({ id: systemAccounts.id });
  if (!account) throw new Error("system account missing");
  const key = generateKey();
  const [row] = await ctx.testDb.db
    .insert(apiKeys)
    .values({
      tenant_id: ctx.tenantId,
      system_account_id: account.id,
      prefix: key.prefix,
      token_sha256: key.hash,
      scopes: ["*"],
    })
    .returning({ id: apiKeys.id });
  if (!row) throw new Error("api key missing");
  return {
    provider: "api_key",
    kind: "system_account",
    id: account.id,
    tenant_id: ctx.tenantId,
    roles: ["member"],
    api_key_id: row.id,
    auth_source: { kind: "api_key", api_key_id: row.id, credential_version: sha256Hex(key.hash) },
  };
}

test("a respond_elicitation job from a system account records the bot as the decider", async () => {
  const principal = await systemAccountPrincipal();
  const created = await svc.createConversation(
    {
      tenant_id: ctx.tenantId,
      actor_id: principal.id,
      principal,
      initial_message: "which region should the bucket live in?",
    },
    ctx.testDb.db,
  );
  const conversation_id = created.conversation.id;
  const elicitation = await createElicitation(
    {
      tenant_id: ctx.tenantId,
      conversation_id,
      tool_call_id: null,
      tool_name: "ask_user_text",
      summary: "Which region?",
      input: { question: "Which region?" },
      actor_id: principal.id,
    },
    ctx.testDb.db,
  );
  const staged = await stageElicitationAnswer(
    { tenant_id: ctx.tenantId, conversation_id, id: elicitation.id, output: { text: "eu-west" } },
    ctx.testDb.db,
  );
  expect(staged.kind).toBe("staged");
  const taskId = await insertMcpTask(
    {
      tenant_id: ctx.tenantId,
      conversation_id,
      kind: "respond_elicitation",
      actor: actorOf(principal),
      request_source: "mcp",
      user_message_id: null,
    },
    ctx.testDb.db,
  );
  const [task] = await ctx.testDb.db
    .select({ actor_id: mcpTasks.actor_id, actor_kind: mcpTasks.actor_kind })
    .from(mcpTasks)
    .where(and(eq(mcpTasks.tenant_id, ctx.tenantId), eq(mcpTasks.id, taskId)));
  expect(task).toEqual({ actor_id: principal.id, actor_kind: "system_account" });

  const data: ConversationRunTurnJob = {
    tenant_id: ctx.tenantId,
    conversation_id,
    mcp_task_id: taskId,
    actor_id: principal.id,
    principal,
    kind: "respond_elicitation",
    elicitation_id: elicitation.id,
  };
  await run([{ id: taskId, data } as Job<ConversationRunTurnJob>]);

  const [row] = await ctx.testDb.db
    .select({
      status: conversationElicitations.status,
      output: conversationElicitations.output,
      decided_by: conversationElicitations.decided_by,
      decided_by_kind: conversationElicitations.decided_by_kind,
    })
    .from(conversationElicitations)
    .where(
      and(
        eq(conversationElicitations.tenant_id, ctx.tenantId),
        eq(conversationElicitations.id, elicitation.id),
      ),
    );
  expect(row).toEqual({
    status: "resolved",
    output: { text: "eu-west" },
    decided_by: principal.id,
    decided_by_kind: "system_account",
  });

  const decisions = await ctx.testDb.db
    .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, ctx.tenantId),
        eq(auditLog.action, AuditAction.APPROVAL_APPROVED),
        eq(auditLog.resource_type, "conversation_elicitation"),
        eq(auditLog.resource_id, elicitation.id),
      ),
    );
  expect(decisions).toEqual([{ actor_type: "system_account", actor_id: principal.id }]);
}, 60_000);
