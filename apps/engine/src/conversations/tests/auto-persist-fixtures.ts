import { afterAll, beforeAll } from "bun:test";
import { conversationElicitations } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { seedTenant } from "../../test-helpers/seed.ts";

export let ctx: TestDb;
export let tenant_id: string;

export async function createCarrierElicitation(p: {
  conversation_id: string;
  tool_name: "ask_user_form" | "ask_user_confirm";
  input: Record<string, unknown>;
  output: Record<string, unknown>;
}): Promise<{ id: string; tool_name: string; input: unknown }> {
  const [row] = await ctx.db
    .insert(conversationElicitations)
    .values({
      tenant_id,
      conversation_id: p.conversation_id,
      tool_name: p.tool_name,
      summary: "test carrier",
      input: p.input,
      output: p.output,
      status: "resolved",
    })
    .returning();
  if (!row) throw new Error("failed to insert elicitation");
  return { id: row.id, tool_name: row.tool_name, input: row.input };
}

export function useAutoPersistSetup(): void {
  beforeAll(async () => {
    ctx = await createTestDb("auto_persist");
    tenant_id = (await seedTenant(ctx.db, { slug: "t-ap", display_name: "T-AP" })).id;
  });

  afterAll(async () => {
    await ctx.cleanup();
  });
}
