import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { conversations, conversationToolCalls, users } from "../../db/schema/index.ts";
import { type ConverseMockStep, getMockProvider } from "../../llm/mock-provider.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { seedConnector, seedWorkflow } from "../../test-helpers/seed.ts";
import { getTaskRunMarker } from "../core/draft.ts";
import type { ConversationTurnOutcome } from "../service/index.ts";
import { createConversation } from "../service/index.ts";
import type { TaskRunMarker } from "../types.ts";
import { appendMessageWithTurn, type ConversationTestCtx } from "./setup.ts";

export const TASK_ID = "44444444-5555-4666-8777-888888888888";
export const TASK_RUN_ID = "55555555-6666-4777-8888-999999999999";

export function principalOf(
  ctx: ConversationTestCtx,
  id: string,
  role: "admin" | "member",
): ResolvedPrincipal {
  return { provider: "session", kind: "user", id, tenant_id: ctx.tenant_id, roles: [role] };
}

export async function seedUser(
  ctx: ConversationTestCtx,
  label: string,
  role: "admin" | "member",
): Promise<string> {
  const [user] = await ctx.testDb.db
    .insert(users)
    .values({
      tenant_id: ctx.tenant_id,
      email: `${label}@task-run.test.local`,
      role_id: await builtinRoleId(ctx.testDb.db, role),
    })
    .returning({ id: users.id });
  if (!user) throw new Error("user fixture missing");
  return user.id;
}

export async function seedRunnableWorkflow(ctx: ConversationTestCtx, slug: string) {
  const seeded = await seedWorkflow(ctx.testDb.db, {
    tenant_id: ctx.tenant_id,
    slug,
    name: slug,
    is_tool: true,
  });
  return seeded.workflow;
}

export async function seedBoundConnector(ctx: ConversationTestCtx, slug: string) {
  return seedConnector(ctx.testDb.db, { tenant_id: ctx.tenant_id, slug });
}

export function markerFor(overrides: Partial<TaskRunMarker> = {}): TaskRunMarker {
  return {
    task_id: TASK_ID,
    task_run_id: TASK_RUN_ID,
    environment: "dev",
    workflow_ids: [],
    connector_ids: [],
    web_search: false,
    ...overrides,
  };
}

export async function createRunConversation(
  ctx: ConversationTestCtx,
  owner_id: string,
  marker: TaskRunMarker | null,
): Promise<string> {
  const created = await createConversation(
    { tenant_id: ctx.tenant_id, actor_id: owner_id, ...(marker ? { task_run: marker } : {}) },
    ctx.testDb.db,
  );
  return created.conversation.id;
}

export async function sealConversation(
  ctx: ConversationTestCtx,
  conversation_id: string,
): Promise<void> {
  const [row] = await ctx.testDb.db
    .select({ draft: conversations.draft })
    .from(conversations)
    .where(and(eq(conversations.tenant_id, ctx.tenant_id), eq(conversations.id, conversation_id)));
  const draft = (row?.draft ?? {}) as { session?: Record<string, unknown> };
  await ctx.testDb.db
    .update(conversations)
    .set({ draft: { ...draft, session: { ...(draft.session ?? {}), task_run: { broken: true } } } })
    .where(and(eq(conversations.tenant_id, ctx.tenant_id), eq(conversations.id, conversation_id)));
}

export async function storedMarker(
  ctx: ConversationTestCtx,
  conversation_id: string,
): Promise<TaskRunMarker | null> {
  const [row] = await ctx.testDb.db
    .select({ draft: conversations.draft })
    .from(conversations)
    .where(and(eq(conversations.tenant_id, ctx.tenant_id), eq(conversations.id, conversation_id)));
  return getTaskRunMarker(row?.draft);
}

export async function driveTurn(
  ctx: ConversationTestCtx,
  conversation_id: string,
  principal: ResolvedPrincipal,
  plan: ConverseMockStep[],
  message = "Continue with the task.",
): Promise<ConversationTurnOutcome> {
  getMockProvider().setConversePlan(conversation_id, plan);
  return appendMessageWithTurn(
    {
      tenant_id: ctx.tenant_id,
      conversation_id,
      actor_id: principal.id,
      principal,
      message,
    },
    ctx.testDb.db,
  );
}

export async function toolCalls(ctx: ConversationTestCtx, conversation_id: string) {
  return ctx.testDb.db
    .select({
      tool: conversationToolCalls.tool,
      input: conversationToolCalls.input,
      output: conversationToolCalls.output,
      outcome: conversationToolCalls.outcome,
    })
    .from(conversationToolCalls)
    .where(
      and(
        eq(conversationToolCalls.tenant_id, ctx.tenant_id),
        eq(conversationToolCalls.conversation_id, conversation_id),
      ),
    )
    .orderBy(conversationToolCalls.created_at);
}

export function lastPalette(): string[] {
  const palettes = getMockProvider().toolPalettes;
  return (palettes[palettes.length - 1] ?? []).map((tool) => tool.name).sort();
}
