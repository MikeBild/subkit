import { afterAll, beforeAll } from "bun:test";
import { eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import { finishConversationTurn } from "../../../conversations/turns.ts";
import { conversationTurns, users } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { resetMockProvider } from "../../../llm/mock-provider.ts";
import { startBoss, stopBoss } from "../../../queue/index.ts";
import { ensureTestConfig } from "../../../queue/tests/test-config.ts";
import { builtinRoleId } from "../../../rbac/roles.ts";
import { testEnv } from "../../../test-helpers/determinism/env.ts";
import { createDeterministicUuidFactory } from "../../../test-helpers/determinism/ids.ts";
import { seedTenant, seedWorkflow as seedWorkflowRow } from "../../../test-helpers/seed.ts";

export let nextIntakeUuid = createDeterministicUuidFactory(0x1a2b_3c4d);

export let testDb: TestDb;

export let principal: ResolvedPrincipal;

export let foreignPrincipal: ResolvedPrincipal;

export async function finishQueuedConversation(conversation_id: string) {
  const rows = await testDb.db
    .select()
    .from(conversationTurns)
    .where(eq(conversationTurns.conversation_id, conversation_id));
  for (const row of rows)
    await finishConversationTurn(testDb.db, principal.tenant_id, conversation_id, row.id);
}

export async function seedWorkflow(
  slug: string,
  steps: Array<Record<string, unknown>>,
): Promise<{ workflow_id: string; version_id: string; slug: string; name: string }> {
  const name = `wf ${slug}`;
  const { workflow, version } = await seedWorkflowRow(testDb.db, {
    tenant_id: principal.tenant_id,
    slug,
    name,
    dag: { name, slug, steps },
  });
  return { workflow_id: workflow.id, version_id: version.id, slug, name };
}

export function setupConversationCapabilities(): void {
  nextIntakeUuid = createDeterministicUuidFactory(0x1a2b_3c4d);
  beforeAll(async () => {
    testEnv.LLM_PROVIDER = "mock";
    await ensureTestConfig();
    resetMockProvider();
    testDb = await createTestDb("mcp_conv_tool");
    const t = await seedTenant(testDb.db, { slug: "t-convtool", display_name: "ConvTool" });
    const [u] = await testDb.db
      .insert(users)
      .values({
        tenant_id: t.id,
        email: "ct@test.local",
        role_id: await builtinRoleId(testDb.db, "admin"),
      })
      .returning();
    if (!u) throw new Error("seed user failed");
    principal = {
      kind: "user",
      id: u.id,
      tenant_id: t.id,
      provider: "api_key",
      roles: ["admin"],
    };
    const t2 = await seedTenant(testDb.db, {
      slug: "t-convtool-foreign",
      display_name: "ConvTool Foreign",
    });
    const [u2] = await testDb.db
      .insert(users)
      .values({
        tenant_id: t2.id,
        email: "foreign@test.local",
        role_id: await builtinRoleId(testDb.db, "admin"),
      })
      .returning();
    if (!u2) throw new Error("seed foreign user failed");
    foreignPrincipal = {
      kind: "user",
      id: u2.id,
      tenant_id: t2.id,
      provider: "api_key",
      roles: ["admin"],
    };
    await startBoss({ connectionString: testDb.url });
  });
  afterAll(async () => {
    await stopBoss(5_000);
    await testDb.cleanup();
  });
}
