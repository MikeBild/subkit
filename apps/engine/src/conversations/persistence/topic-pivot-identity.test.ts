import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import { conversationElicitations, conversations, workflows } from "../../db/schema/index.ts";
import {
  withLatestPreview,
  withWorkflowInspection,
  withWorkflowValidation,
} from "../authoring-state/index.ts";
import { appendSnapshot, loadDraft } from "../draft.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "../tests/setup.ts";
import type { ToolContext } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";
import { commitWorkflowAtomic } from "./commit-workflow.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("topic_pivot_identity");
});

afterAll(async () => {
  await ctx.cleanup();
});

function readyDraft(slug: string, name = slug): DraftDocument {
  const base: DraftDocument = {
    mode: "workflow_authoring",
    workflow: {
      name,
      slug,
      steps: [
        {
          id: "echo",
          kind: "transform",
          expression: "return input.input;",
          language: "javascript",
        },
      ],
    },
  };
  let draft = withWorkflowInspection(base);
  draft = withWorkflowValidation(draft, true, "Workflow draft validated.");
  draft = withLatestPreview(draft, {
    ok: true,
    summary: "preview ok",
    warnings: [],
  });
  return draft;
}

function stubToolCtx(conversationId: string, draft: DraftDocument): ToolContext {
  let live = draft;
  return {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: conversationId,
    actor_id: ctx.user_id,
    connector_id: null,
    workflow_id: null,
    permission_mode: null,
    // biome-ignore lint/suspicious/noExplicitAny: minimal engineClient stub
    engineClient: {} as any,
    getDraft: () => live,
    setDraft: async (next) => {
      live = next;
      await appendSnapshot(ctx.tenant_id, conversationId, next, ctx.testDb.db);
    },
  };
}

async function observedEdit(
  conversationId: string,
  slug: string,
  name: string,
): Promise<DraftDocument> {
  const observed = await loadDraft(ctx.tenant_id, conversationId, ctx.testDb.db);
  const draft = readyDraft(slug, name);
  if (!draft.state) throw new Error("ready draft state missing");
  draft.state.persisted_resources = observed.state?.persisted_resources ?? [];
  return draft;
}

async function freshConversation(): Promise<string> {
  const [row] = await ctx.testDb.db
    .insert(conversations)
    .values({ tenant_id: ctx.tenant_id, status: "active" })
    .returning({ id: conversations.id });
  if (!row) throw new Error("seed conversation failed");
  return row.id;
}

async function seedApprovedConfirm(conversationId: string): Promise<void> {
  await ctx.testDb.db.insert(conversationElicitations).values({
    tenant_id: ctx.tenant_id,
    conversation_id: conversationId,
    tool_name: "ask_user_confirm",
    summary: "commit",
    input: {
      kind: "save_workflow_draft",
      summary: "commit",
      commit_intent: { kind: "save_workflow_draft", payload: {}, description: "commit" },
    },
    output: { confirmed: true },
    status: "resolved",
  });
}

describe("save_workflow_draft · identity gate", () => {
  test("topic pivot creates a new workflow row instead of overwriting the previous one", async () => {
    const conversationId = await freshConversation();

    await seedApprovedConfirm(conversationId);
    const berlinResult = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, readyDraft("berlin-weather-forecast", "Berlin Weather")),
    });
    expect(berlinResult.ok).toBe(true);
    const berlinData = berlinResult.data as { workflow_id: string; slug: string };
    expect(berlinData.slug).toBe("berlin-weather-forecast");

    const convAfterBerlin = await ctx.testDb.db
      .select({ target_workflow_id: conversations.target_workflow_id })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    expect(convAfterBerlin[0]?.target_workflow_id).toBe(berlinData.workflow_id);

    await seedApprovedConfirm(conversationId);
    const githubResult = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, readyDraft("github-private-repos", "GitHub Private Repos")),
    });
    expect(githubResult.ok).toBe(true);
    const githubData = githubResult.data as { workflow_id: string; slug: string };

    expect(githubData.workflow_id).not.toBe(berlinData.workflow_id);
    expect(githubData.slug).toBe("github-private-repos");

    const live = await ctx.testDb.db
      .select({ id: workflows.id, slug: workflows.slug, name: workflows.name })
      .from(workflows)
      .where(and(eq(workflows.tenant_id, ctx.tenant_id), isNull(workflows.deleted_at)));
    const slugs = live.map((r) => r.slug).sort();
    expect(slugs).toContain("berlin-weather-forecast");
    expect(slugs).toContain("github-private-repos");

    const berlinRow = live.find((r) => r.slug === "berlin-weather-forecast");
    expect(berlinRow?.name).toBe("Berlin Weather");
    expect(berlinRow?.id).toBe(berlinData.workflow_id);
  });

  test("explicit target_workflow_id overrides the identity check (intentional update path)", async () => {
    const conversationId = await freshConversation();

    await seedApprovedConfirm(conversationId);
    const first = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, readyDraft("alpha", "Alpha v1")),
    });
    expect(first.ok).toBe(true);
    const firstData = first.data as { workflow_id: string; version: number };

    await seedApprovedConfirm(conversationId);
    const unobserved = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, readyDraft("would-be-new-slug", "Alpha v2")),
      target_workflow_id: firstData.workflow_id,
      forceCommit: true,
    });
    expect(unobserved.ok).toBe(false);
    if (unobserved.ok) throw new Error("unobserved replacement unexpectedly saved");
    expect(unobserved.error_code).toBe("draft_base_not_observed");
    const overwrite = await commitWorkflowAtomic({
      ctx: stubToolCtx(
        conversationId,
        await observedEdit(conversationId, "would-be-new-slug", "Alpha v2"),
      ),
      target_workflow_id: firstData.workflow_id,
    });
    expect(overwrite.ok).toBe(true);
    const overwriteData = overwrite.data as { workflow_id: string; version: number };

    expect(overwriteData.workflow_id).toBe(firstData.workflow_id);
    expect(overwriteData.version).toBeGreaterThan(firstData.version);

    const live = await ctx.testDb.db
      .select({ id: workflows.id, slug: workflows.slug })
      .from(workflows)
      .where(and(eq(workflows.tenant_id, ctx.tenant_id), isNull(workflows.deleted_at)));
    const matchingRows = live.filter((r) => r.id === firstData.workflow_id);
    expect(matchingRows).toHaveLength(1);
  });

  test("identical slug + sticky id → still an update of the same row (no false positive)", async () => {
    const conversationId = await freshConversation();

    await seedApprovedConfirm(conversationId);
    const first = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, readyDraft("idempotent", "Idempotent v1")),
    });
    expect(first.ok).toBe(true);
    const firstData = first.data as { workflow_id: string; version: number };

    await seedApprovedConfirm(conversationId);
    const second = await commitWorkflowAtomic({
      ctx: stubToolCtx(
        conversationId,
        await observedEdit(conversationId, "idempotent", "Idempotent v2"),
      ),
    });
    expect(second.ok).toBe(true);
    const secondData = second.data as { workflow_id: string; version: number };

    expect(secondData.workflow_id).toBe(firstData.workflow_id);
    expect(secondData.version).toBeGreaterThan(firstData.version);
  });

  test("topic pivot into a slug already taken by another workflow → slug_conflict_with_live_workflow", async () => {
    const conversationId = await freshConversation();

    await seedApprovedConfirm(conversationId);
    const first = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, readyDraft("alpha-wf", "Alpha")),
    });
    expect(first.ok).toBe(true);

    const otherConv = await freshConversation();
    await seedApprovedConfirm(otherConv);
    const seedBeta = await commitWorkflowAtomic({
      ctx: stubToolCtx(otherConv, readyDraft("beta-wf", "Beta")),
    });
    expect(seedBeta.ok).toBe(true);

    await seedApprovedConfirm(conversationId);
    const collision = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, readyDraft("beta-wf", "Beta from chat")),
    });
    expect(collision.ok).toBe(false);
    const data = collision.data as { error_code?: string };
    expect(data.error_code).toBe("slug_conflict_with_live_workflow");
  });
});
