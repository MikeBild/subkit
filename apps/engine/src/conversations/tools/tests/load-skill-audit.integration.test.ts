import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { AuditAction } from "../../../audit/types.ts";
import { auditLog } from "../../../db/schema/index.ts";
import { createConversation } from "../../service.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "../../tests/setup.ts";
import type { ToolContext } from "../index.ts";
import { loadSkillTool } from "../load-skill.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("load_skill_audit");
});

afterAll(async () => {
  await ctx.cleanup();
});

function makeCtx(conversation_id: string): ToolContext {
  return {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id,
    actor_id: ctx.user_id,
    connector_id: null,
    workflow_id: null,
    engineClient: {
      skills: {
        list: async () => [
          {
            id: "skill-prefer-get",
            slug: "prefer-get-for-lists",
            title: "prefer-get-for-lists",
            body: "Prefer GET for listing endpoints.",
            scope: "global",
          },
        ],
      },
    } as unknown as ToolContext["engineClient"],
    getDraft: () => {
      throw new Error("load_skill does not touch the draft");
    },
    setDraft: async () => {},
  } as unknown as ToolContext;
}

async function skillLoadedRows(conversation_id: string) {
  return ctx.testDb.db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, ctx.tenant_id),
        eq(auditLog.action, AuditAction.CONVERSATION_SKILL_LOADED),
        eq(auditLog.resource_id, conversation_id),
      ),
    );
}

describe("load_skill — audit chokepoint", () => {
  test("first load writes one tenant-scoped skill_loaded audit row", async () => {
    const created = await createConversation(
      { tenant_id: ctx.tenant_id, actor_id: ctx.user_id, title: "load-skill-audit" },
      ctx.testDb.db,
    );
    const toolCtx = makeCtx(created.conversation.id);

    const res = await loadSkillTool.execute(toolCtx, { slug: "prefer-get-for-lists" });
    expect(res.ok).toBe(true);

    const rows = await skillLoadedRows(created.conversation.id);
    expect(rows.length).toBe(1);
    const meta = rows[0]?.metadata as Record<string, unknown>;
    expect(meta?.skill_slug).toBe("prefer-get-for-lists");
    expect(meta?.already_loaded).toBe(false);
    expect(rows[0]?.tenant_id).toBe(ctx.tenant_id);
  });

  test("re-load re-promotes and writes a second (already_loaded) audit row", async () => {
    const created = await createConversation(
      { tenant_id: ctx.tenant_id, actor_id: ctx.user_id, title: "load-skill-audit-reload" },
      ctx.testDb.db,
    );
    const toolCtx = makeCtx(created.conversation.id);

    await loadSkillTool.execute(toolCtx, { slug: "prefer-get-for-lists" });
    await loadSkillTool.execute(toolCtx, { slug: "prefer-get-for-lists" });

    const rows = await skillLoadedRows(created.conversation.id);
    expect(rows.length).toBe(2);
    const flags = rows.map((r) => (r.metadata as Record<string, unknown>)?.already_loaded).sort();
    expect(flags).toEqual([false, true]);
  });
});
