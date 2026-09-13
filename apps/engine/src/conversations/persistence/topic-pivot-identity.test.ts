// Regression for session 5b97ec58 (the Berlin-weather → GitHub-repos
// pivot). Pre-fix the conversation row carried a sticky
// `target_workflow_id` set on the first commit, and any subsequent
// save_workflow_draft — even one for a logically NEW workflow with a
// different slug — silently `updateWorkflow`'d that same row. Engine
// audit logs showed three `workflow.updated` events on the same id
// because the engine never noticed the topic pivot.
//
// Post-fix `commitWorkflowAtomic` reads the persisted row's slug and
// compares it to the draft's slug. When they diverge AND the caller
// did NOT pass an explicit `target_workflow_id`, the sticky id is
// dropped and the create path runs, which surfaces a real
// `slug_conflict_with_live_workflow` error if the new slug is also
// taken — letting the LLM ask the user before any write happens.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";

import { conversationElicitations, conversations, workflows } from "../../db/schema/index.ts";
import {
  withLatestPreview,
  withWorkflowInspection,
  withWorkflowValidation,
} from "../authoring-state.ts";
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal engineClient stub
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
    // The commit gate authorizes on `commit_intent.kind` — the
    // authoritative field — not the cosmetic top-level `kind`.
    input: {
      kind: "save_workflow_draft",
      summary: "commit",
      commit_intent: { kind: "save_workflow_draft", payload: {}, description: "commit" },
    },
    output: { confirmed: true },
    status: "resolved",
  });
}

describe("save_workflow_draft · identity gate (session 5b97ec58)", () => {
  test("topic pivot creates a new workflow row instead of overwriting the previous one", async () => {
    const conversationId = await freshConversation();

    // Turn 1 — Berlin weather. Standard create path.
    await seedApprovedConfirm(conversationId);
    const berlinResult = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, readyDraft("berlin-weather-forecast", "Berlin Weather")),
    });
    expect(berlinResult.ok).toBe(true);
    const berlinData = berlinResult.data as { workflow_id: string; slug: string };
    expect(berlinData.slug).toBe("berlin-weather-forecast");

    // Conversation row now points at the Berlin workflow — this is the
    // sticky id that, pre-fix, would have been the upsert key for the
    // next commit.
    const convAfterBerlin = await ctx.testDb.db
      .select({ target_workflow_id: conversations.target_workflow_id })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    expect(convAfterBerlin[0]?.target_workflow_id).toBe(berlinData.workflow_id);

    // Turn 2 — user pivots to GitHub. The LLM builds a new draft with a
    // different slug; the conversation row's sticky id still points at
    // Berlin. No `target_workflow_id` passed in the params (the LLM
    // didn't realise the conversation was bound to Berlin).
    await seedApprovedConfirm(conversationId);
    const githubResult = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, readyDraft("github-private-repos", "GitHub Private Repos")),
    });
    expect(githubResult.ok).toBe(true);
    const githubData = githubResult.data as { workflow_id: string; slug: string };

    // Two distinct workflow rows — the pivot did NOT overwrite Berlin.
    expect(githubData.workflow_id).not.toBe(berlinData.workflow_id);
    expect(githubData.slug).toBe("github-private-repos");

    // Both rows live with their original slugs.
    const live = await ctx.testDb.db
      .select({ id: workflows.id, slug: workflows.slug, name: workflows.name })
      .from(workflows)
      .where(and(eq(workflows.tenant_id, ctx.tenant_id), isNull(workflows.deleted_at)));
    const slugs = live.map((r) => r.slug).sort();
    expect(slugs).toContain("berlin-weather-forecast");
    expect(slugs).toContain("github-private-repos");

    // Berlin row was untouched — name still "Berlin Weather", not
    // "GitHub Private Repos". Pre-fix this assertion failed: the row
    // had been overwritten with the GitHub workflow's name.
    const berlinRow = live.find((r) => r.slug === "berlin-weather-forecast");
    expect(berlinRow?.name).toBe("Berlin Weather");
    expect(berlinRow?.id).toBe(berlinData.workflow_id);
  });

  test("explicit target_workflow_id overrides the identity check (intentional update path)", async () => {
    const conversationId = await freshConversation();

    // Seed a workflow with slug "alpha".
    await seedApprovedConfirm(conversationId);
    const first = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, readyDraft("alpha", "Alpha v1")),
    });
    expect(first.ok).toBe(true);
    const firstData = first.data as { workflow_id: string; version: number };

    // Now the LLM has drafted something with a *different* slug but
    // the user has confirmed they want to overwrite the alpha row —
    // the LLM signals that intent by passing `target_workflow_id`
    // explicitly. The identity gate must defer to the explicit target.
    // Note: commitWorkflowAtomic → updateWorkflow does not rename the
    // slug column (renames go through updateWorkflowMetadata); the
    // target row is updated in place, version bumped, slug unchanged.
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

    // Same row id, version bumped — proves the explicit override
    // bypassed the identity gate (which would otherwise have created
    // a new row for the divergent slug).
    expect(overwriteData.workflow_id).toBe(firstData.workflow_id);
    expect(overwriteData.version).toBeGreaterThan(firstData.version);

    // Exactly one row for slug "alpha" still exists — the gate did
    // not silently spawn a "would-be-new-slug" sibling.
    const live = await ctx.testDb.db
      .select({ id: workflows.id, slug: workflows.slug })
      .from(workflows)
      .where(and(eq(workflows.tenant_id, ctx.tenant_id), isNull(workflows.deleted_at)));
    const matchingRows = live.filter((r) => r.id === firstData.workflow_id);
    expect(matchingRows).toHaveLength(1);
  });

  test("identical slug + sticky id → still an update of the same row (no false positive)", async () => {
    const conversationId = await freshConversation();

    // First commit → workflow row exists, sticky id set.
    await seedApprovedConfirm(conversationId);
    const first = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, readyDraft("idempotent", "Idempotent v1")),
    });
    expect(first.ok).toBe(true);
    const firstData = first.data as { workflow_id: string; version: number };

    // Second commit, SAME slug — the legitimate "edit and re-save"
    // case. Identity gate must NOT clear targetWorkflowId here; the
    // commit should bump the version of the same row.
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

    // Seed two existing workflows. The second is the one the next
    // pivot will collide with — pre-fix, the pivot would have silently
    // updated the FIRST row (sticky id) and never noticed the
    // collision.
    await seedApprovedConfirm(conversationId);
    const first = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, readyDraft("alpha-wf", "Alpha")),
    });
    expect(first.ok).toBe(true);

    // A second workflow with slug "beta-wf" exists in this tenant via
    // a separate conversation — seeded through the same code path so
    // schema invariants (workflow_versions row, lifecycle, etc.) are
    // satisfied.
    const otherConv = await freshConversation();
    await seedApprovedConfirm(otherConv);
    const seedBeta = await commitWorkflowAtomic({
      ctx: stubToolCtx(otherConv, readyDraft("beta-wf", "Beta")),
    });
    expect(seedBeta.ok).toBe(true);

    // Now the LLM, still in the alpha-bound conversation, drafts a
    // workflow with slug "beta-wf". Identity gate clears the alpha
    // sticky id, the create path runs, and the existing "beta-wf"
    // collision surfaces a structured error the LLM can act on.
    await seedApprovedConfirm(conversationId);
    const collision = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, readyDraft("beta-wf", "Beta from chat")),
    });
    expect(collision.ok).toBe(false);
    const data = collision.data as { error_code?: string };
    expect(data.error_code).toBe("slug_conflict_with_live_workflow");
  });
});
