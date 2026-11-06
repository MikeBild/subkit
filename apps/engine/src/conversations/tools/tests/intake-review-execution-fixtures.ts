import { afterAll, beforeAll } from "bun:test";
import { z } from "@hono/zod-openapi";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import type { Db } from "../../../db/client.ts";
import { conversations, tenants, users } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { createIntakeItem, createSessionIntakeItem } from "../../../knowledge/index.ts";
import { builtinRoleId } from "../../../rbac/roles.ts";
import { createDeterministicUuidFactory } from "../../../test-helpers/determinism/ids.ts";
import { createEmptyDraftDocument } from "../../authoring-state/index.ts";
import type { ConversationTool, ToolContext } from "../index.ts";
import type { wrapOne } from "../sdk-wrap/invoke.ts";
import type { TurnSignals, WrappedToolOutput } from "../sdk-wrap/state.ts";

export const nextUuid = createDeterministicUuidFactory(0x1a7e_0082);

export let tdb: TestDb;
export let db: Db;
export let tenantId: string;
export let userId: string;
export let principal: ResolvedPrincipal;

export function signals(): TurnSignals {
  return {
    step: 0,
    toolChain: Promise.resolve(),
    pendingChildToolCallIds: [],
    pendingChildElicitationIds: [],
    toolInvocationCount: new Map(),
    toolLastErrorHash: new Map(),
    toolArgsRepeat: new Map(),
    toolValidationFingerprint: new Map(),
    toolErrorCodeRepeat: new Map(),
    totalLoopWarnings: 0,
    consecutiveFailures: 0,
    lastAssistantText: "",
    lastExecutionSuccess: null,
  };
}

export async function newConversation(): Promise<string> {
  const [conversation] = await tdb.db
    .insert(conversations)
    .values({ tenant_id: tenantId, status: "active" })
    .returning({ id: conversations.id });
  if (!conversation) throw new Error("conversation seed failed");
  return conversation.id;
}

export function toolContext(conversationId: string, initial = createEmptyDraftDocument()) {
  let draft = initial;
  const ctx: ToolContext = {
    db,
    tenant_id: tenantId,
    conversation_id: conversationId,
    actor_id: userId,
    principal,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({
      tenant_id: tenantId,
      actor_id: userId,
      actor_type: "user",
      db,
    }),
    getDraft: () => draft,
    setDraft: async (next) => {
      draft = next;
    },
    surface: "web",
  };
  return { ctx, draft: () => draft };
}

export async function createItem(title: string, body = `${title} source text`) {
  return createIntakeItem(
    {
      tenant_id: tenantId,
      actor: { kind: "user", id: userId },
      client_request_id: nextUuid(),
      title,
      source_url: `https://example.test/${encodeURIComponent(title)}`,
      captured_at: "2026-10-10T07:00:00.000Z",
      body,
    },
    tdb.db,
  );
}

export async function createSessionItem(title: string) {
  return (
    await createSessionIntakeItem(
      {
        tenant_id: tenantId,
        actor: { kind: "user", id: userId },
        title,
        body: `${title} learning body`,
        captured_at: "2026-10-10T07:00:00.000Z",
        session: {
          agent: "codex",
          session_id: `session-${nextUuid()}`,
          repo: "example/repo",
          domains: [],
          evidence_excerpt: `${title} evidence`,
        },
      },
      tdb.db,
    )
  ).item;
}

export function writeTool(
  name: "create_knowledge_source" | "save_learning" | "update_skill" | "delete_skill",
  called: () => void,
): ConversationTool {
  return {
    name,
    description: name,
    inputSchema: z.object({}),
    category: "tenant_write",
    async execute() {
      called();
      return { ok: true, data: {} };
    },
  };
}

export function isAsyncIterable(
  value: WrappedToolOutput | AsyncIterable<WrappedToolOutput>,
): value is AsyncIterable<WrappedToolOutput> {
  return Symbol.asyncIterator in value;
}

export async function executeWrapped(
  wrapped: ReturnType<typeof wrapOne>,
  args: Record<string, unknown>,
): Promise<WrappedToolOutput> {
  const result = await wrapped.execute!(args, {
    toolCallId: nextUuid(),
    messages: [],
    context: {},
  });
  if (isAsyncIterable(result)) throw new Error("streaming tool output is not expected");
  return result;
}

export function useIntakeReviewExecutionSetup(): void {
  beforeAll(async () => {
    tdb = await createTestDb("intake-review-execution");
    db = tdb.db as unknown as Db;
    const [tenant] = await tdb.db
      .insert(tenants)
      .values({ slug: "t-intake-review-execution", display_name: "Intake Review Execution" })
      .returning();
    if (!tenant) throw new Error("tenant seed failed");
    tenantId = tenant.id;
    const [user] = await tdb.db
      .insert(users)
      .values({
        tenant_id: tenantId,
        email: "intake-review-execution@test.local",
        role_id: await builtinRoleId(tdb.db, "admin"),
      })
      .returning();
    if (!user) throw new Error("user seed failed");
    userId = user.id;
    principal = {
      provider: "test",
      kind: "user",
      id: userId,
      tenant_id: tenantId,
      roles: ["admin"],
    };
  }, 60_000);

  afterAll(async () => {
    await tdb.cleanup();
  }, 30_000);
}
