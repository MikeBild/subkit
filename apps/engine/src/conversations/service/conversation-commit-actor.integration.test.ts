import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { AuditAction } from "../../audit/types.ts";
import { auditLog, conversations, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";

const WORKFLOW_ID = "10000000-0000-4000-8000-000000000031";
const SYSTEM_ACCOUNT_ID = "10000000-0000-4000-8000-000000000032";
let testDb: TestDb;
let tenant_id: string;
let runConversationTurn: typeof import("./run-turn.ts").runConversationTurn;

mock.module("../loop/index.ts", () => ({
  runLoop: async () => ({
    events: [],
    status: "committed",
    committed_workflow_id: WORKFLOW_ID,
  }),
}));

beforeAll(async () => {
  testDb = await createTestDb("conversation_commit_actor");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "conversation-commit-actor", display_name: "Conversation Commit Actor" })
    .returning({ id: tenants.id });
  if (!tenant) throw new Error("tenant seed failed");
  tenant_id = tenant.id;
  ({ runConversationTurn } = await import("./run-turn.ts"));
});

afterAll(async () => {
  await testDb.cleanup();
});

test("committed turn audit preserves the typed system-account principal", async () => {
  const [conversation] = await testDb.db
    .insert(conversations)
    .values({ tenant_id, status: "active" })
    .returning({ id: conversations.id });
  if (!conversation) throw new Error("conversation seed failed");

  const outcome = await runConversationTurn(
    {
      tenant_id,
      conversation_id: conversation.id,
      actor_id: SYSTEM_ACCOUNT_ID,
      principal: {
        provider: "test",
        kind: "system_account",
        id: SYSTEM_ACCOUNT_ID,
        tenant_id,
        roles: [],
      },
      user_message: "Please summarize this conversation.",
      answer_actor: { kind: "human", user_id: SYSTEM_ACCOUNT_ID, via: "chat" },
      turn_abort_ctrl: new AbortController(),
    },
    testDb.db,
  );

  expect(outcome.result.status).toBe("committed");
  const [audit] = await testDb.db
    .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, tenant_id),
        eq(auditLog.action, AuditAction.CONVERSATION_COMMITTED),
        eq(auditLog.resource_id, conversation.id),
      ),
    )
    .limit(1);
  expect(audit).toEqual({ actor_type: "system_account", actor_id: SYSTEM_ACCOUNT_ID });
});
