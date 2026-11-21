import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, count, eq } from "drizzle-orm";
import { conversations, skillCandidates, skills } from "../../db/schema/index.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import {
  withLatestPreview,
  withWorkflowInspection,
  withWorkflowValidation,
} from "../authoring-state/index.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "../tests/setup.ts";
import type { ToolContext } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";
import { commitWorkflowAtomic } from "./commit-workflow.ts";

const skip = testEnv.REQUIRES_PG === "0";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  if (skip) return;
  ctx = await createConversationTestCtx("sc-commit");
}, 120_000);

afterAll(async () => {
  if (skip) return;
  await ctx?.cleanup();
}, 30_000);

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
    // biome-ignore lint/suspicious/noExplicitAny: minimal engineClient stub
    engineClient: {} as any,
    getDraft: () => live,
    setDraft: async (next) => {
      live = next;
    },
  };
}

describe.skipIf(skip)(
  "D.1 — first commit records exactly one authoring_capability context note",
  () => {
    test("skill_candidate row has status:context, pattern_kind:authoring_capability, scope:workflow", async () => {
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
      expect(candidate.status).toBe("context");
      expect(candidate.pattern_kind).toBe("authoring_capability");
      expect(candidate.scope).toBe("workflow");
      expect(candidate.workflow_id).toBe(workflowId);
      expect(candidate.version).toBe(1);
      expect(candidate.body).toContain("This note describes preparation, not an active capability");
      expect(candidate.body).toContain("the workflow is neither activated nor authorized to run");
      expect(candidate.body).not.toContain("/runs");
      expect(candidate.body).toContain(
        (result.data as { workflow_version_id: string }).workflow_version_id,
      );
    }, 60_000);
  },
);

describe.skipIf(skip)(
  "D.2 — re-commit same workflow (same schemas, different step body) bumps version, no duplicate",
  () => {
    test("two commits → one skill_candidate row, version incremented", async () => {
      const conversationId = await freshConversation();

      const firstDraft = readyDraftWithSchemas("sc-recommit", "SC Recommit", "return input.input;");
      const firstCtx = stubToolCtx(conversationId, firstDraft);
      const first = await commitWorkflowAtomic({
        ctx: firstCtx,
        skipPriorApprovalCheck: true,
      });
      expect(first.ok).toBe(true);
      const workflowId = (first.data as Record<string, unknown>).workflow_id as string;

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

      const secondDraft = readyDraftWithSchemas(
        "sc-recommit",
        "SC Recommit v2",
        "return input.input ?? null;",
      );
      if (!secondDraft.state) throw new Error("ready draft state missing");
      secondDraft.state.persisted_resources = firstCtx.getDraft().state?.persisted_resources ?? [];
      const secondCtx = stubToolCtx(conversationId, secondDraft);
      const second = await commitWorkflowAtomic({
        ctx: secondCtx,
        skipPriorApprovalCheck: true,
      });
      expect(second.ok).toBe(true);

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

      const v2 = afterCandidates[0]!;
      expect(v2.id).toBe(v1.id);
      expect(v2.version).toBeGreaterThan(v1.version);
      expect(v2.status).toBe("context");
    }, 60_000);
  },
);

describe.skipIf(skip)(
  "D.3 — no skills row with lifecycle:active created by workflow commit",
  () => {
    test("active skills count is unchanged after commit", async () => {
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

      const [after] = await ctx.testDb.db
        .select({ n: count() })
        .from(skills)
        .where(and(eq(skills.tenant_id, ctx.tenant_id), eq(skills.lifecycle, "active")));
      const countAfter = after?.n ?? 0;

      expect(countAfter).toBe(countBefore);
    }, 60_000);
  },
);

describe.skipIf(skip)(
  "D.4 — commit result next_prompt does not invite approving the candidate",
  () => {
    test("next_prompt names no skill candidate and no approve URL", async () => {
      const conversationId = await freshConversation();
      const toolCtx = stubToolCtx(conversationId, readyDraft("sc-notice-check", "SC Notice Check"));
      const result = await commitWorkflowAtomic({
        ctx: toolCtx,
        skipPriorApprovalCheck: true,
      });
      expect(result.ok).toBe(true);

      const data = result.data as Record<string, unknown>;
      const nextPrompt = data.next_prompt as string | undefined;

      expect(typeof nextPrompt).toBe("string");
      expect(nextPrompt).not.toContain("/v1/skill-candidates/");
      expect(nextPrompt).not.toContain("Skill-Candidate");

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
      expect(nextPrompt).not.toContain(candidateRows[0]!.id);
    }, 60_000);
  },
);
