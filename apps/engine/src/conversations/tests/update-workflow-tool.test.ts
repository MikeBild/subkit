// Locks the chat-native workflow metadata patch contract:
//
//   - update_workflow with name only changes the display name
//   - update_workflow with slug renames in place; slug uniqueness
//     is enforced; collisions return slug_conflict_with_live_workflow
//   - update_workflow with lifecycle archives in place
//   - audit emits WORKFLOW_UPDATED with metadata.kind="metadata"
//     plus from/to snapshots — no new audit-action enum entry.
//
// Reference parity: the reference codebase exposes rename + lifecycle
// only as HTTP datastore ops; subkit's chat-first contract requires
// the same op be reachable as a chat tool. See
// `apps/engine/src/conversations/tools/generated/writes/update-workflow.ts`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { auditLog, conversations, workflows, workflowVersions } from "../../db/schema/index.ts";
import { createEmptyDraftDocument } from "../authoring-state.ts";
import { updateWorkflowTool } from "../tools/generated/writes/update-workflow.ts";
import type { ToolContext } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("update_workflow_tool");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function seedLiveWorkflow(slug: string, name: string): Promise<{ id: string }> {
  const [wf] = await ctx.testDb.db
    .insert(workflows)
    .values({
      tenant_id: ctx.tenant_id,
      slug,
      name,
      lifecycle: "active",
    })
    .returning();
  if (!wf) throw new Error("seed workflow failed");
  const [version] = await ctx.testDb.db
    .insert(workflowVersions)
    .values({
      tenant_id: ctx.tenant_id,
      workflow_id: wf.id,
      version: 1,
      dag: {
        name,
        slug,
        steps: [{ id: "p1", kind: "transform", expression: "$input", language: "jsonata" }],
      },
    })
    .returning();
  if (!version) throw new Error("seed workflow version failed");
  await ctx.testDb.db
    .update(workflows)
    .set({ current_version_id: version.id })
    .where(eq(workflows.id, wf.id));
  return { id: wf.id };
}

function toolCtx(): ToolContext {
  return buildToolCtx();
}

function buildToolCtx(params?: {
  conversation_id?: string;
  draft?: DraftDocument;
  setDraft?: (next: DraftDocument) => Promise<void>;
}): ToolContext {
  // biome-ignore lint/suspicious/noExplicitAny: minimal stub matching ToolContext
  const engineClientStub: any = {
    context: {
      actor_id: ctx.user_id,
      actor_type: "user",
    },
    workflows: {
      update: async (params: {
        id: string;
        slug?: string;
        name?: string;
        description?: string | null;
        lifecycle?: "active" | "archived";
      }) => {
        const { updateWorkflowMetadata } = await import("../../workflows/service.ts");
        return updateWorkflowMetadata(
          {
            tenant_id: ctx.tenant_id,
            id: params.id,
            ...(params.slug !== undefined ? { slug: params.slug } : {}),
            ...(params.name !== undefined ? { name: params.name } : {}),
            ...(params.description !== undefined ? { description: params.description } : {}),
            ...(params.lifecycle !== undefined ? { lifecycle: params.lifecycle } : {}),
            actor_id: ctx.user_id,
          },
          ctx.testDb.db,
        );
      },
    },
    audit_write: async (entry: Record<string, unknown>) => {
      const { auditAwait } = await import("../../audit/audit.ts");
      const { AuditAction } = await import("../../audit/types.ts");
      return auditAwait(
        {
          tenant_id: ctx.tenant_id,
          actor_type: "user",
          actor_id: ctx.user_id,
          // Funnel the test stub's free-form action into the existing
          // WORKFLOW_UPDATED action — the production audit_write helper
          // does the same mapping; we keep tests within the typed enum.
          action: AuditAction.WORKFLOW_UPDATED,
          resource_type: String(entry.resource_type),
          resource_id: String(entry.resource_id),
          result: (entry.result as "success" | "error" | "denied") ?? "success",
          metadata: {
            via_action: String(entry.action),
            ...((entry.metadata as Record<string, unknown>) ?? {}),
          },
        },
        ctx.testDb.db,
      );
    },
  };
  return {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: params?.conversation_id ?? "00000000-0000-0000-0000-000000000000",
    actor_id: ctx.user_id,
    connector_id: null,
    workflow_id: null,
    permission_mode: "auto",
    engineClient: engineClientStub,
    getDraft: () => params?.draft ?? createEmptyDraftDocument(),
    setDraft: params?.setDraft ?? (async () => {}),
  };
}

describe("update_workflow tool — chat-native metadata patch", () => {
  test("renames a workflow (slug + name) in place", async () => {
    const wf = await seedLiveWorkflow("legacy-slug-rn", "Legacy Name");

    const result = await updateWorkflowTool.execute(toolCtx(), {
      id: wf.id,
      slug: "fresh-slug-rn",
      name: "Fresh Name",
    });

    expect(result.ok).toBe(true);
    const data = result.data as {
      updated: boolean;
      workflow: { id: string; slug: string; name: string };
    };
    expect(data.updated).toBe(true);
    expect(data.workflow.slug).toBe("fresh-slug-rn");
    expect(data.workflow.name).toBe("Fresh Name");

    // The workflow row was patched in place — id unchanged.
    const refetched = await ctx.testDb.db
      .select({ slug: workflows.slug, name: workflows.name })
      .from(workflows)
      .where(eq(workflows.id, wf.id))
      .limit(1);
    expect(refetched[0]?.slug).toBe("fresh-slug-rn");
    expect(refetched[0]?.name).toBe("Fresh Name");

    // No new workflow_versions row was added (metadata-only patch).
    const vrows = await ctx.testDb.db
      .select({ version: workflowVersions.version })
      .from(workflowVersions)
      .where(eq(workflowVersions.workflow_id, wf.id));
    expect(vrows.length).toBe(1);

    // Audit emits WORKFLOW_UPDATED with metadata.kind="metadata".
    const auditRows = await ctx.testDb.db
      .select({ action: auditLog.action, metadata: auditLog.metadata })
      .from(auditLog)
      .where(eq(auditLog.resource_id, wf.id));
    const updateRow = auditRows.find((r) => r.action === "workflow.updated");
    expect(updateRow).toBeDefined();
    const meta = (updateRow?.metadata ?? {}) as {
      kind?: string;
      from?: { slug: string; name: string };
      to?: { slug: string; name: string };
    };
    expect(meta.kind).toBe("metadata");
    expect(meta.from?.slug).toBe("legacy-slug-rn");
    expect(meta.to?.slug).toBe("fresh-slug-rn");
    expect(meta.from?.name).toBe("Legacy Name");
    expect(meta.to?.name).toBe("Fresh Name");
  });

  test("refuses on slug collision against a different live workflow", async () => {
    const taken = await seedLiveWorkflow("taken-slug-uw", "Already Here");
    const target = await seedLiveWorkflow("target-slug-uw", "To Rename");

    const result = await updateWorkflowTool.execute(toolCtx(), {
      id: target.id,
      slug: "taken-slug-uw",
    });

    expect(result.ok).toBe(false);
    const data = result.data as {
      error: string;
      conflict?: { workflow_id: string };
    };
    expect(data.error).toBe("slug_conflict_with_live_workflow");
    expect(data.conflict?.workflow_id).toBe(taken.id);

    // The target workflow was NOT mutated.
    const refetched = await ctx.testDb.db
      .select({ slug: workflows.slug })
      .from(workflows)
      .where(eq(workflows.id, target.id))
      .limit(1);
    expect(refetched[0]?.slug).toBe("target-slug-uw");
  });

  test("archives a workflow via lifecycle without touching slug or version history", async () => {
    const wf = await seedLiveWorkflow("to-archive-uw", "To Archive");

    const result = await updateWorkflowTool.execute(toolCtx(), {
      id: wf.id,
      lifecycle: "archived",
    });

    expect(result.ok).toBe(true);
    const data = result.data as {
      workflow: { lifecycle: string; slug: string };
    };
    expect(data.workflow.lifecycle).toBe("archived");
    expect(data.workflow.slug).toBe("to-archive-uw");

    const auditRows = await ctx.testDb.db
      .select({ action: auditLog.action, metadata: auditLog.metadata })
      .from(auditLog)
      .where(eq(auditLog.resource_id, wf.id));
    const meta = (auditRows.find((r) => r.action === "workflow.updated")?.metadata ?? {}) as {
      kind?: string;
      from?: { lifecycle?: string };
      to?: { lifecycle?: string };
    };
    expect(meta.kind).toBe("metadata");
    expect(meta.from?.lifecycle).toBe("active");
    expect(meta.to?.lifecycle).toBe("archived");
  });

  test("binds the renamed workflow back into the conversation state", async () => {
    const wf = await seedLiveWorkflow("bind-after-rename", "Bind After Rename");
    const [conversation] = await ctx.testDb.db
      .insert(conversations)
      .values({
        tenant_id: ctx.tenant_id,
        status: "active",
        draft: createEmptyDraftDocument() as unknown as Record<string, unknown>,
      })
      .returning();
    if (!conversation) throw new Error("conversation insert failed");

    let nextDraft: unknown = null;
    const result = await updateWorkflowTool.execute(
      buildToolCtx({
        conversation_id: conversation.id,
        draft: createEmptyDraftDocument(),
        setDraft: async (draft) => {
          nextDraft = draft;
        },
      }),
      {
        id: wf.id,
        slug: "berlin-weather",
      },
    );

    expect(result.ok).toBe(true);
    const conversationRows = await ctx.testDb.db
      .select({ target_workflow_id: conversations.target_workflow_id })
      .from(conversations)
      .where(eq(conversations.id, conversation.id))
      .limit(1);
    expect(conversationRows[0]?.target_workflow_id).toBe(wf.id);
    if (!nextDraft) throw new Error("next draft was not captured");
    const capturedDraft = nextDraft as DraftDocument;
    expect(capturedDraft.summary?.active_target).toEqual({
      kind: "workflow",
      id: wf.id,
      slug: "berlin-weather",
      name: "Bind After Rename",
      environment: null,
      lifecycle_state: "persisted",
    });
  });

  test("rejects an empty patch (no slug, name, description, or lifecycle)", async () => {
    const wf = await seedLiveWorkflow("empty-patch-uw", "Untouched");

    const result = await updateWorkflowTool
      .execute(toolCtx(), { id: wf.id })
      .catch((err) => ({ ok: false as const, threw: err }));

    // The Zod refinement throws — caller surfaces it as a parse error,
    // which is the expected shape (Zod errors propagate without being
    // wrapped in a structured tool result for invalid input).
    if ("threw" in result) {
      expect(String(result.threw)).toMatch(
        /at least one of slug, name, description, or lifecycle/i,
      );
    } else {
      expect(result.ok).toBe(false);
    }
  });

  test("sets a description on the workflows.description column without a new version", async () => {
    const wf = await seedLiveWorkflow("describe-me-uw", "Describe Me");
    const richDescription =
      "Converts a Notion essay page into Markdown with YAML frontmatter. Phase 1 of a publishing pipeline.";

    const result = await updateWorkflowTool.execute(toolCtx(), {
      id: wf.id,
      description: richDescription,
    });

    expect(result.ok).toBe(true);
    const data = result.data as { workflow: { description: string | null } };
    expect(data.workflow.description).toBe(richDescription);

    // Persisted to the column, not the DAG, and no new version row.
    const refetched = await ctx.testDb.db
      .select({ description: workflows.description })
      .from(workflows)
      .where(eq(workflows.id, wf.id))
      .limit(1);
    expect(refetched[0]?.description).toBe(richDescription);
    const vrows = await ctx.testDb.db
      .select({ version: workflowVersions.version })
      .from(workflowVersions)
      .where(eq(workflowVersions.workflow_id, wf.id));
    expect(vrows.length).toBe(1);

    // The `wf_<slug>` catalog now surfaces the column description (not the
    // bland name) — this is the regression the live `update_workflow`
    // repair-loop produced.
    const { listWorkflowToolsForTenant } = await import("../../workflows/catalog.ts");
    const catalog = await listWorkflowToolsForTenant({
      db: ctx.testDb.db,
      // biome-ignore lint/suspicious/noExplicitAny: minimal principal stub
      principal: { tenant_id: ctx.tenant_id, allowed_workflows: "all" } as any,
    });
    const entry = catalog.find((c) => c.slug === "describe-me-uw");
    expect(entry?.description).toBe(richDescription);

    // Audit from/to carries the description transition.
    const auditRows = await ctx.testDb.db
      .select({ action: auditLog.action, metadata: auditLog.metadata })
      .from(auditLog)
      .where(eq(auditLog.resource_id, wf.id));
    const meta = (auditRows.find((r) => r.action === "workflow.updated")?.metadata ?? {}) as {
      kind?: string;
      from?: { description?: string | null };
      to?: { description?: string | null };
    };
    expect(meta.kind).toBe("metadata");
    expect(meta.from?.description ?? null).toBeNull();
    expect(meta.to?.description).toBe(richDescription);
  });

  test("clears a description with an empty string (stored as NULL)", async () => {
    const wf = await seedLiveWorkflow("clear-desc-uw", "Clear Desc");
    await updateWorkflowTool.execute(toolCtx(), { id: wf.id, description: "temporary" });

    const result = await updateWorkflowTool.execute(toolCtx(), { id: wf.id, description: "" });
    expect(result.ok).toBe(true);

    const refetched = await ctx.testDb.db
      .select({ description: workflows.description })
      .from(workflows)
      .where(eq(workflows.id, wf.id))
      .limit(1);
    expect(refetched[0]?.description ?? null).toBeNull();
  });
});
