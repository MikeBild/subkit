import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createSkill } from "../../skills/service.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { knowledgeSourceReadTools } from "../tools/engine-api/knowledge-sources.ts";
import { findSkillTool } from "../tools/find-skill.ts";
import type { ToolContext } from "../tools/index.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

const searchKnowledge = knowledgeSourceReadTools.find((t) => t.name === "search_knowledge");

function searchCtx(hits: unknown[]): ToolContext {
  const engineClient = {
    knowledgeSources: {
      search: async () => hits,
      list: async () => [
        { status: "active", scope: "global", workflow_id: null, tags: ["billing", "shipping"] },
        { status: "active", scope: "global", workflow_id: null, tags: ["shipping"] },
        { status: "inactive", scope: "global", workflow_id: null, tags: ["archive"] },
      ],
    },
  };
  return { engineClient, workflow_id: null } as unknown as ToolContext;
}

describe("search_knowledge", () => {
  test("an empty result names the available tags", async () => {
    const result = await searchKnowledge?.execute(searchCtx([]), { query: "refund rules" });
    expect(result?.ok).toBe(true);
    expect(result?.data).toMatchObject({
      hits: [],
      available_tags: ["shipping", "billing"],
      hint: expect.stringContaining("Available tags: shipping, billing."),
    });
  });

  test("a result with hits carries no hint", async () => {
    const result = await searchKnowledge?.execute(searchCtx([{ id: "h" }]), { query: "refunds" });
    expect(result?.data).toEqual({ hits: [{ id: "h" }] });
  });
});

const skip = testEnv.REQUIRES_PG === "0";
let ctx: ConversationTestCtx;

describe.skipIf(skip)("find_skill", () => {
  beforeAll(async () => {
    ctx = await createConversationTestCtx("find_skill_active");
    for (const status of ["active", "draft", "archived"] as const)
      await createSkill(
        {
          tenant_id: ctx.tenant_id,
          input: {
            scope: "global",
            title: `Invoice rule ${status}`,
            body: "How invoices are checked.",
            status,
          },
        },
        ctx.testDb.db,
      );
  }, 60_000);

  afterAll(async () => {
    await ctx?.cleanup();
  }, 30_000);

  test("lists only active skills", async () => {
    const result = await findSkillTool.execute(
      { tenant_id: ctx.tenant_id, db: ctx.testDb.db } as unknown as ToolContext,
      { query: "invoice", limit: 10 },
    );
    expect(result.ok).toBe(true);
    const titles = JSON.stringify(result.data);
    expect(titles).toContain("Invoice rule active");
    expect(titles).not.toContain("Invoice rule draft");
    expect(titles).not.toContain("Invoice rule archived");
  });
});
