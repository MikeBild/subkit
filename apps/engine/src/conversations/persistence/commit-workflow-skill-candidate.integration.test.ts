// Integration tests: commitWorkflowAtomic creates and maintains skill-candidates.
// Case (v) from the regression test plan for workflow-authoring hardening.
//
// Contracts verified:
//   D.1  First commit → exactly ONE skill_candidate row with
//        status "proposed", pattern_kind "authoring_capability",
//        scope "workflow", workflow_id = the committed workflow.
//   D.2  Re-committing the same workflow with a different step body
//        (same schemas, same workflow_id) → version bump on the ONE
//        existing candidate; no duplicate row created.
//   D.3  No skills row with lifecycle "active" is created by the commit
//        path. Active skills are only created via the explicit approve gate.
//   D.4  The commit result's next_prompt carries the human-readable
//        candidate notice line (POST /v1/skill-candidates/<id>/approve).
//
// Requires Postgres — set REQUIRES_PG=0 to skip.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, count, eq } from "drizzle-orm";
import { conversations, skillCandidates, skills } from "../../db/schema/index.ts";
import {
  withLatestPreview,
  withWorkflowInspection,
  withWorkflowValidation,
} from "../authoring-state.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "../tests/setup.ts";
import type { ToolContext } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";
import { commitWorkflowAtomic } from "./commit-workflow.ts";

const skip = process.env.REQUIRES_PG === "0";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  if (skip) return;
  ctx = await createConversationTestCtx("sc-commit");
}, 120_000);

afterAll(async () => {
  if (skip) return;
  await ctx?.cleanup();
}, 30_000);

// ---------------------------------------------------------------------------
// Helpers — shared with commit-workflow-gates pattern
// ---------------------------------------------------------------------------

/** Build a fully ready draft that passes all commit gates (inspection +
 *  validation + successful preview). `skipPriorApprovalCheck: true` bypasses
 *  the approval elicitation so these tests focus on skill-candidate behavior. */
function readyDraft(
  slug: string,
  name = slug,
  stepExpression = "return input.input;",
): DraftDocument {
  const base: DraftDocument = {
    mode: "workflow_authoring",
    workflow: {
      name,
      slug,
      steps: [
        {
          id: "echo",
          kind: "transform",
          expression: stepExpression,
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

/** Build a ready draft that includes declared input/output schemas. */
function readyDraftWithSchemas(
  slug: string,
  name = slug,
  stepExpression = "return input.input;",
): DraftDocument {
  const base: DraftDocument = {
    mode: "workflow_authoring",
    workflow: {
      name,
      slug,
      input_schema: {
        type: "object",
        properties: { reportDate: { type: "string", description: "ISO 8601 date" } },
        required: ["reportDate"],
      },
      output_schema: {
        type: "object",
        properties: { rows: { type: "array" } },
      },
      steps: [
        {
          id: "echo",
          kind: "transform",
          expression: stepExpression,
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

async function freshConversation(): Promise<string> {
  const [row] = await ctx.testDb.db
    .insert(conversations)
    .values({ tenant_id: ctx.tenant_id, status: "active" })
    .returning({ id: conversations.id });
  if (!row) throw new Error("seed conversation failed");
  return row.id;
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
    },
  };
}

// ---------------------------------------------------------------------------
// D.1 First commit creates exactly one proposed skill candidate
// ---------------------------------------------------------------------------

describe.skipIf(skip)(
  "D.1 — first commit creates exactly one proposed authoring_capability candidate",
  () => {
    test("skill_candidate row has status:proposed, pattern_kind:authoring_capability, scope:workflow", async () => {
      const conversationId = await freshConversation();
      const draft = readyDraft("sc-first-commit", "SC First Commit");
      const toolCtx = stubToolCtx(conversationId, draft);

      const result = await commitWorkflowAtomic({
        ctx: toolCtx,
        skipPriorApprovalCheck: true,
      });

      expect(result.ok).toBe(true);
      const workflowId = (result.data as Record<string, unknown>).workflow_id as string;
      expect(workflowId).toBeDefined();

      // Exactly one skill_candidate for this workflow.
      const candidates = await ctx.testDb.db
        .select()
        .from(skillCandidates)
        .where(
          and(
            eq(skillCandidates.tenant_id, ctx.tenant_id),
            eq(skillCandidates.workflow_id, workflowId),
          ),
        );
      expect(candidates).toHaveLength(1);

      const candidate = candidates[0]!;
      expect(candidate.status).toBe("proposed");
      expect(candidate.pattern_kind).toBe("authoring_capability");
      expect(candidate.scope).toBe("workflow");
      expect(candidate.workflow_id).toBe(workflowId);
      // Initial version is always 1.
      expect(candidate.version).toBe(1);
    }, 60_000);
  },
);

// ---------------------------------------------------------------------------
// D.2 Re-commit same workflow → version bump, no duplicate
// ---------------------------------------------------------------------------

describe.skipIf(skip)(
  "D.2 — re-commit same workflow (same schemas, different step body) bumps version, no duplicate",
  () => {
    test("two commits → one skill_candidate row, version incremented", async () => {
      const conversationId = await freshConversation();

      // First commit: establish the workflow and the initial skill candidate.
      const firstDraft = readyDraftWithSchemas("sc-recommit", "SC Recommit", "return input.input;");
      const firstCtx = stubToolCtx(conversationId, firstDraft);
      const first = await commitWorkflowAtomic({
        ctx: firstCtx,
        skipPriorApprovalCheck: true,
      });
      expect(first.ok).toBe(true);
      const workflowId = (first.data as Record<string, unknown>).workflow_id as string;

      // Verify initial candidate state.
      const beforeCandidates = await ctx.testDb.db
        .select()
        .from(skillCandidates)
        .where(
          and(
            eq(skillCandidates.tenant_id, ctx.tenant_id),
            eq(skillCandidates.workflow_id, workflowId),
          ),
        );
      expect(beforeCandidates).toHaveLength(1);
      const v1 = beforeCandidates[0]!;
      expect(v1.version).toBe(1);

      // Second commit: same slug + schemas, different step expression.
      // The def hash changes (different step), so `isUnchangedFromCurrentVersion`
      // returns false → a new workflow version is written. But the skill-candidate
      // fingerprint (workflow_id + schemas) is identical → upsertFromSignal
      // updates the existing row rather than inserting a new one.
      const secondDraft = readyDraftWithSchemas(
        "sc-recommit",
        "SC Recommit v2",
        "return input.input ?? null;", // different expression
      );
      // Use the same conversationId — `target_workflow_id` was written there
      // by the first commit and is picked up automatically.
      const secondCtx = stubToolCtx(conversationId, secondDraft);
      const second = await commitWorkflowAtomic({
        ctx: secondCtx,
        skipPriorApprovalCheck: true,
      });
      expect(second.ok).toBe(true);

      // Still exactly one candidate for this workflow — no duplicate created.
      const afterCandidates = await ctx.testDb.db
        .select()
        .from(skillCandidates)
        .where(
          and(
            eq(skillCandidates.tenant_id, ctx.tenant_id),
            eq(skillCandidates.workflow_id, workflowId),
          ),
        );
      expect(afterCandidates).toHaveLength(1);

      // Version was bumped.
      const v2 = afterCandidates[0]!;
      expect(v2.id).toBe(v1.id); // same row
      expect(v2.version).toBeGreaterThan(v1.version);
      // Status remains proposed — approve is never triggered by commit.
      expect(v2.status).toBe("proposed");
    }, 60_000);
  },
);

// ---------------------------------------------------------------------------
// D.3 No active skills row created by the commit path
// ---------------------------------------------------------------------------

describe.skipIf(skip)(
  "D.3 — no skills row with lifecycle:active created by workflow commit",
  () => {
    test("active skills count is unchanged after commit", async () => {
      // Count active skills BEFORE the commit (only the pre-seeded rows).
      const [before] = await ctx.testDb.db
        .select({ n: count() })
        .from(skills)
        .where(and(eq(skills.tenant_id, ctx.tenant_id), eq(skills.lifecycle, "active")));
      const countBefore = before?.n ?? 0;

      const conversationId = await freshConversation();
      const toolCtx = stubToolCtx(conversationId, readyDraft("sc-no-skill-row", "SC No Skill Row"));
      const result = await commitWorkflowAtomic({
        ctx: toolCtx,
        skipPriorApprovalCheck: true,
      });
      expect(result.ok).toBe(true);

      // Count active skills AFTER the commit.
      const [after] = await ctx.testDb.db
        .select({ n: count() })
        .from(skills)
        .where(and(eq(skills.tenant_id, ctx.tenant_id), eq(skills.lifecycle, "active")));
      const countAfter = after?.n ?? 0;

      // The commit path must never write a skill row — only a skill_candidate.
      // Active skills are created only when an operator explicitly approves a
      // candidate via POST /v1/skill-candidates/<id>/approve.
      expect(countAfter).toBe(countBefore);
    }, 60_000);
  },
);

// ---------------------------------------------------------------------------
// D.4 Commit result next_prompt carries the candidate notice
// ---------------------------------------------------------------------------

describe.skipIf(skip)("D.4 — commit result next_prompt contains the candidate notice line", () => {
  test("next_prompt includes POST /v1/skill-candidates/<id>/approve", async () => {
    const conversationId = await freshConversation();
    const toolCtx = stubToolCtx(conversationId, readyDraft("sc-notice-check", "SC Notice Check"));
    const result = await commitWorkflowAtomic({
      ctx: toolCtx,
      skipPriorApprovalCheck: true,
    });
    expect(result.ok).toBe(true);

    const data = result.data as Record<string, unknown>;
    const nextPrompt = data.next_prompt as string | undefined;

    // The operator must be able to act on the candidate from the LLM
    // turn summary; the approve URL must be present in the prompt.
    expect(typeof nextPrompt).toBe("string");
    expect(nextPrompt).toContain("/v1/skill-candidates/");
    expect(nextPrompt).toContain("/approve");

    // The workflow id embedded in the URL must match the committed workflow.
    const workflowId = data.workflow_id as string;
    const candidateRows = await ctx.testDb.db
      .select({ id: skillCandidates.id })
      .from(skillCandidates)
      .where(
        and(
          eq(skillCandidates.tenant_id, ctx.tenant_id),
          eq(skillCandidates.workflow_id, workflowId),
        ),
      );
    expect(candidateRows).toHaveLength(1);
    const candidateId = candidateRows[0]!.id;
    // The notice line must reference the actual candidate id.
    expect(nextPrompt).toContain(candidateId);
  }, 60_000);
});
