import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { skills, tenants } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { createEmptyDraftDocument } from "./authoring-state.ts";
import { saveWorkflowDraftTool } from "./tools/save-workflow-draft.ts";
import type { DraftDocument } from "./types.ts";

const skip = process.env.REQUIRES_PG === "0";
let ctx: TestDb;
let tenant_id: string;

beforeAll(async () => {
  if (skip) return;
  ctx = await createTestDb("destructive-banner");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "dest-banner", display_name: "db" })
    .returning();
  tenant_id = t!.id;
  await ctx.db.insert(skills).values({
    tenant_id,
    slug: "destructive-write",
    scope: "global",
    title: "Destructive Write",
    body: "Body",
    examples: { examples: [], best_practices: [], pitfalls: [], doc_refs: [] },
    lifecycle: "active",
    source: "manual",
    version: 1,
    side_effects: "destructive",
    activates_when: [],
    gates_tools: [],
    tags: [],
  });
  await ctx.db.insert(skills).values({
    tenant_id,
    slug: "safe-read",
    scope: "global",
    title: "Safe Read",
    body: "Body",
    examples: { examples: [], best_practices: [], pitfalls: [], doc_refs: [] },
    lifecycle: "active",
    source: "manual",
    version: 1,
    side_effects: "read",
    activates_when: [],
    gates_tools: [],
    tags: [],
  });
}, 60_000);

afterAll(async () => {
  if (!skip && ctx?.cleanup) await ctx.cleanup();
}, 30_000);

function buildDraft(opts: { derived_from_skill_id: string | null }): DraftDocument {
  const d = createEmptyDraftDocument();
  d.workflow = {
    name: "wf",
    slug: "wf",
    steps: [
      {
        kind: "request",
        id: "step1",
        method: "GET",
        url: "https://example.com/x",
      },
    ],
    ...(opts.derived_from_skill_id ? { derived_from_skill_id: opts.derived_from_skill_id } : {}),
  };
  return d;
}

function makeToolCtx(opts: {
  tenant_id: string;
  conversation_id: string;
  draft: DraftDocument;
}): Parameters<typeof saveWorkflowDraftTool.execute>[0] {
  return {
    db: ctx.db,
    tenant_id: opts.tenant_id,
    conversation_id: opts.conversation_id,
    actor_id: null,
    getDraft: () => opts.draft,
    setDraft: async () => {},
  } as unknown as Parameters<typeof saveWorkflowDraftTool.execute>[0];
}

describe.skipIf(skip)("save_workflow_draft — destructive-skill confirmation gate", () => {
  test("derived from a destructive skill + confirmed=false → typed refusal", async () => {
    const conversation_id = "00000000-0000-0000-0000-000000000aaa";
    const draft = buildDraft({ derived_from_skill_id: "destructive-write" });
    const result = await saveWorkflowDraftTool.execute(
      makeToolCtx({ tenant_id, conversation_id, draft }),
      { force_commit: false, confirmed: false },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("destructive_skill_confirmation_required");
      const data = result.data as { side_effects?: string } | undefined;
      expect(data?.side_effects).toBe("destructive");
    }
  });

  test("non-destructive derivation passes the gate", async () => {
    const conversation_id = "00000000-0000-0000-0000-000000000bbb";
    const draft = buildDraft({ derived_from_skill_id: "safe-read" });
    const result = await saveWorkflowDraftTool.execute(
      makeToolCtx({ tenant_id, conversation_id, draft }),
      { force_commit: false, confirmed: false },
    );
    if (!result.ok) {
      expect(result.error_code).not.toBe("destructive_skill_confirmation_required");
    }
  });

  test("no derived_from_skill_id → gate is a no-op", async () => {
    const conversation_id = "00000000-0000-0000-0000-000000000ccc";
    const draft = buildDraft({ derived_from_skill_id: null });
    const result = await saveWorkflowDraftTool.execute(
      makeToolCtx({ tenant_id, conversation_id, draft }),
      { force_commit: false, confirmed: false },
    );
    if (!result.ok) {
      expect(result.error_code).not.toBe("destructive_skill_confirmation_required");
    }
  });
});
