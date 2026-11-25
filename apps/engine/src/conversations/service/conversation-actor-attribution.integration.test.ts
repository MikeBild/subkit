import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { AuditAction, type AuditActionValue } from "../../audit/types.ts";
import { auditLog, conversations, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { openedElicitation } from "../../test-helpers/elicitations.ts";
import { createElicitation } from "../elicitations.ts";
import { dispatchRollbackSkipped } from "../persistence/auto-persist/dispatch.ts";
import type { CommitIntent } from "../tools/ask-user/commit-intent.ts";
import type { ToolContext } from "../tools/index.ts";
import { appendUserMessage } from "./append.ts";
import { cancelConversation, patchConversation } from "./lifecycle.ts";

let testDb: TestDb;
let tenant_id: string;

const SYSTEM_ACCOUNT_ID = "10000000-0000-4000-8000-000000000011";
const UNKNOWN_ACTOR_ID = "10000000-0000-4000-8000-000000000012";

async function createConversation(owner_id: string | null = null): Promise<string> {
  const [conversation] = await testDb.db
    .insert(conversations)
    .values({ tenant_id, status: "active", owner_id })
    .returning({ id: conversations.id });
  if (!conversation) throw new Error("conversation seed failed");
  return conversation.id;
}

async function auditFor(action: AuditActionValue, resource_id: string) {
  const [entry] = await testDb.db
    .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, tenant_id),
        eq(auditLog.action, action),
        eq(auditLog.resource_id, resource_id),
      ),
    )
    .limit(1);
  return entry;
}

beforeAll(async () => {
  testDb = await createTestDb("conversation_actor_attribution");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "conversation-actor-attribution", display_name: "Actor Attribution" })
    .returning({ id: tenants.id });
  if (!tenant) throw new Error("tenant seed failed");
  tenant_id = tenant.id;
});

afterAll(async () => {
  await testDb.cleanup();
});

describe("conversation actor attribution", () => {
  test("memory injection preserves a typed system-account principal", async () => {
    const conversation_id = await createConversation(SYSTEM_ACCOUNT_ID);

    await appendUserMessage(
      {
        tenant_id,
        conversation_id,
        actor_id: SYSTEM_ACCOUNT_ID,
        principal: {
          provider: "test",
          kind: "system_account",
          id: SYSTEM_ACCOUNT_ID,
          tenant_id,
          roles: [],
        },
        message: "continue",
        memory: "Persisted context",
      },
      testDb.db,
    );

    expect(await auditFor(AuditAction.CONVERSATION_MEMORY_INJECTED, conversation_id)).toEqual({
      actor_type: "system_account",
      actor_id: SYSTEM_ACCOUNT_ID,
    });
  });

  test("cancel preserves a typed system-account actor", async () => {
    const conversation_id = await createConversation();

    await cancelConversation(
      tenant_id,
      conversation_id,
      SYSTEM_ACCOUNT_ID,
      testDb.db,
      "system_account",
    );

    expect(await auditFor(AuditAction.CONVERSATION_CANCELLED, conversation_id)).toEqual({
      actor_type: "system_account",
      actor_id: SYSTEM_ACCOUNT_ID,
    });
  });

  test("patch treats an untyped actor id as unknown and clears it", async () => {
    const conversation_id = await createConversation();

    await patchConversation(
      { tenant_id, conversation_id, actor_id: UNKNOWN_ACTOR_ID, title: "Updated title" },
      testDb.db,
    );

    expect(await auditFor(AuditAction.CONVERSATION_UPDATED, conversation_id)).toEqual({
      actor_type: "unknown",
      actor_id: null,
    });
  });

  test("elicitation audit retains a typed system-account actor", async () => {
    const conversation_id = await createConversation();
    const elicitation = openedElicitation(
      await createElicitation(
        {
          tenant_id,
          conversation_id,
          tool_call_id: null,
          tool_name: "ask_user_confirm",
          summary: "Confirm the action",
          input: { question: "Proceed?" },
          actor_id: SYSTEM_ACCOUNT_ID,
          actor_type: "system_account",
        },
        testDb.db,
      ),
    );

    expect(await auditFor(AuditAction.APPROVAL_REQUESTED, elicitation.id)).toEqual({
      actor_type: "system_account",
      actor_id: SYSTEM_ACCOUNT_ID,
    });
  });

  test("skipped rollback audit retains the typed system-account actor", async () => {
    const conversation_id = await createConversation();
    const context = {
      db: testDb.db,
      tenant_id,
      conversation_id,
      actor_id: SYSTEM_ACCOUNT_ID,
      engineClient: new EngineClient({
        tenant_id,
        actor_id: SYSTEM_ACCOUNT_ID,
        actor_type: "system_account",
        db: testDb.db,
      }),
    } as ToolContext;

    await dispatchRollbackSkipped(context, {
      kind: "rollback_after_execute",
      payload: { execution_id: "10000000-0000-4000-8000-000000000013" },
      description: "Skip rollback",
    } satisfies CommitIntent);

    expect(
      await auditFor(AuditAction.EXECUTION_ABORTED, "10000000-0000-4000-8000-000000000013"),
    ).toEqual({ actor_type: "system_account", actor_id: SYSTEM_ACCOUNT_ID });
  });
});
