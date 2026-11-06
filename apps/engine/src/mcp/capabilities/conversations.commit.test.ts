import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { withWorkflowPersisted } from "../../conversations/authoring-state/index.ts";
import { appendSnapshot } from "../../conversations/draft.ts";
import type { DraftDocument } from "../../conversations/types.ts";
import { conversations, workflows, workflowVersions } from "../../db/schema/index.ts";
import { handleConversationTool } from "./conversations.ts";
import {
  principal,
  seedWorkflow,
  setupConversationCapabilities,
  testDb,
} from "./tests/conversations-fixtures.ts";

setupConversationCapabilities();

describe("conversation_commit — inline auto-commit reconciliation", () => {
  test("null target_workflow_id but a bound draft resolves the committed workflow (not the error)", async () => {
    const wf = await seedWorkflow("hb-committed", [
      { id: "shape", kind: "transform", language: "javascript", expression: "return input;" },
    ]);
    const [conv] = await testDb.db
      .insert(conversations)
      .values({
        tenant_id: principal.tenant_id,
        owner_id: principal.id,
        status: "committed",
        target_workflow_id: null,
      })
      .returning();
    if (!conv) throw new Error("seed conversation failed");
    const boundDraft = withWorkflowPersisted(
      { workflow: { name: wf.name, steps: [] } },
      {
        kind: "workflow",
        id: wf.workflow_id,
        slug: wf.slug,
        name: wf.name,
        version_id: wf.version_id,
        version: 1,
        environment: null,
        saved_at: "2026-07-01T00:00:00.000Z",
      },
    );
    await appendSnapshot(principal.tenant_id, conv.id, boundDraft, testDb.db);

    const got = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_commit",
      args: { conversation_id: conv.id },
    });
    expect(got.isError).toBe(false);
    const body = JSON.parse(got.content[0]?.text ?? "{}") as {
      workflow_id: string;
      conversation_id: string;
      committed?: { workflow_version_id: string; version: number; steps_present: number };
      draft_state?: string;
      verified_against_draft?: boolean;
      note?: string;
      usage?: unknown;
    };
    expect(body.workflow_id).toBe(wf.workflow_id);
    expect(body.conversation_id).toBe(conv.id);
    expect(body.usage).toBeDefined();
    expect(body.committed).toEqual(
      expect.objectContaining({
        workflow_version_id: wf.version_id,
        version: 1,
        steps_present: 1,
      }),
    );
    expect(body.draft_state).toBe("empty_draft");
    expect(body.verified_against_draft).toBe(false);
    expect(body.note).toBeDefined();
  });

  test("a stamped target_workflow_id still commits and carries usage", async () => {
    const wf = await seedWorkflow("hb-stamped", [
      { id: "shape", kind: "transform", language: "javascript", expression: "return input;" },
    ]);
    const [conv] = await testDb.db
      .insert(conversations)
      .values({
        tenant_id: principal.tenant_id,
        owner_id: principal.id,
        status: "committed",
        target_workflow_id: wf.workflow_id,
      })
      .returning();
    if (!conv) throw new Error("seed conversation failed");

    const got = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_commit",
      args: { conversation_id: conv.id },
    });
    expect(got.isError).toBe(false);
    const body = JSON.parse(got.content[0]?.text ?? "{}") as {
      workflow_id: string;
      committed?: { workflow_version_id: string; version: number; steps_present: number };
    };
    expect(body.workflow_id).toBe(wf.workflow_id);
    const [wfRow] = await testDb.db
      .select({ current_version_id: workflows.current_version_id })
      .from(workflows)
      .where(eq(workflows.id, wf.workflow_id));
    const [vRow] = await testDb.db
      .select({ version: workflowVersions.version, dag: workflowVersions.dag })
      .from(workflowVersions)
      .where(eq(workflowVersions.id, wf.version_id));
    expect(body.committed?.workflow_version_id).toBe(wfRow?.current_version_id ?? "");
    expect(body.committed?.version).toBe(vRow?.version ?? -1);
    expect(body.committed?.steps_present).toBe(
      ((vRow!.dag as { steps?: unknown[] })?.steps ?? []).length,
    );
  });

  test("a workflow with no persisted version returns NOT COMMITTED, not success", async () => {
    const [workflow] = await testDb.db
      .insert(workflows)
      .values({
        tenant_id: principal.tenant_id,
        slug: "hb-unversioned",
        name: "wf hb-unversioned",
        lifecycle: "draft",
      })
      .returning();
    if (!workflow) throw new Error("workflow insert failed");
    const [conv] = await testDb.db
      .insert(conversations)
      .values({
        tenant_id: principal.tenant_id,
        owner_id: principal.id,
        status: "committed",
        target_workflow_id: workflow.id,
      })
      .returning();
    if (!conv) throw new Error("seed conversation failed");

    const got = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_commit",
      args: { conversation_id: conv.id },
    });
    expect(got.isError).toBe(true);
    expect(got.content[0]?.text ?? "").toContain("NOT COMMITTED");
    expect(got.content[0]?.text ?? "").toContain("no persisted version");
  });

  test("an unreadable persisted dag returns COMMIT UNVERIFIED, not success", async () => {
    const wf = await seedWorkflow("hb-corrupt", [
      { id: "shape", kind: "transform", language: "javascript", expression: "return input;" },
    ]);
    await testDb.db
      .update(workflowVersions)
      .set({ dag: { not_a: "workflow" } })
      .where(eq(workflowVersions.id, wf.version_id));
    const [conv] = await testDb.db
      .insert(conversations)
      .values({
        tenant_id: principal.tenant_id,
        owner_id: principal.id,
        status: "committed",
        target_workflow_id: wf.workflow_id,
      })
      .returning();
    if (!conv) throw new Error("seed conversation failed");
    const boundDraft: DraftDocument = withWorkflowPersisted(
      {
        workflow: {
          name: wf.name,
          slug: wf.slug,
          steps: [
            { id: "shape", kind: "transform", language: "javascript", expression: "return input;" },
          ],
        },
      },
      {
        kind: "workflow",
        id: wf.workflow_id,
        slug: wf.slug,
        name: wf.name,
        version_id: wf.version_id,
        version: 1,
        environment: null,
        saved_at: "2026-07-01T00:00:00.000Z",
      },
    );
    await appendSnapshot(principal.tenant_id, conv.id, boundDraft, testDb.db);

    const got = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_commit",
      args: { conversation_id: conv.id },
    });
    expect(got.isError).toBe(true);
    expect(got.content[0]?.text ?? "").toContain("COMMIT UNVERIFIED");
  });

  test("a structural draft still returns the NOT COMMITTED directive error", async () => {
    const wf = await seedWorkflow("hb-structural", [
      { id: "shape", kind: "transform", language: "javascript", expression: "return input;" },
    ]);
    const [conv] = await testDb.db
      .insert(conversations)
      .values({
        tenant_id: principal.tenant_id,
        owner_id: principal.id,
        status: "active",
        target_workflow_id: wf.workflow_id,
      })
      .returning();
    if (!conv) throw new Error("seed conversation failed");
    const dirtyDraft: DraftDocument = withWorkflowPersisted(
      {
        workflow: {
          name: wf.name,
          slug: wf.slug,
          steps: [
            {
              id: "shape",
              kind: "transform",
              language: "javascript",
              expression: "return { changed: true };",
            },
          ],
        },
      },
      {
        kind: "workflow",
        id: wf.workflow_id,
        slug: wf.slug,
        name: wf.name,
        version_id: wf.version_id,
        version: 1,
        environment: null,
        saved_at: "2026-07-01T00:00:00.000Z",
      },
    );
    await appendSnapshot(principal.tenant_id, conv.id, dirtyDraft, testDb.db);

    const got = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_commit",
      args: { conversation_id: conv.id },
    });
    expect(got.isError).toBe(true);
    expect(got.content[0]?.text).toContain("NOT COMMITTED");
  });
});
