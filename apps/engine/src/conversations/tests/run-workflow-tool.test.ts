import { describe, expect, test } from "bun:test";
import "../tools/index.ts";
import { and, eq } from "drizzle-orm";
import {
  connectors,
  conversations,
  executions,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { saveWorkflowDraft } from "../../workflows/drafts.ts";
import { bindPersistedWorkflow } from "../authoring-state/index.ts";
import { runWorkflowTool } from "../tools/engine-api/writes/run-workflow.ts";
import type { DraftDocument } from "../types.ts";
import {
  buildToolCtx,
  ctx,
  seedWorkflow,
  useRunWorkflowToolSetup,
} from "./run-workflow-tool-fixtures.ts";

useRunWorkflowToolSetup();

const nextUuid = createDeterministicUuidFactory(0x5a_11);

describe("run_workflow tool", () => {
  test("a status question cannot start a workflow that has not declared a read effect", async () => {
    const { workflow_id } = await seedWorkflow("status-read-guard");
    const result = await runWorkflowTool.execute(
      buildToolCtx({
        conversation_id: nextUuid(),
        draft: {} as DraftDocument,
        setDraft: async () => {},
        recentUserMessage: "Wie steht meine Anfrage Nummer 5?",
      }),
      { workflow: workflow_id, environment: "dev" },
    );
    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({ error_code: "status_request_read_only" });
  });

  test("refuses a prepared run when its exact version is no longer active", async () => {
    const { workflow_id, version_id } = await seedWorkflow("prepared-version-stale");
    const [replacement] = await ctx.testDb.db
      .insert(workflowVersions)
      .values({
        tenant_id: ctx.tenant_id,
        workflow_id,
        version: 2,
        dag: {
          name: "Replacement",
          slug: "prepared-version-stale",
          steps: [
            {
              id: "shape",
              kind: "transform",
              language: "javascript",
              expression: "return { replacement: true };",
            },
          ],
        },
      })
      .returning();
    if (!replacement) throw new Error("replacement insert failed");
    await ctx.testDb.db
      .update(workflows)
      .set({ current_version_id: replacement.id })
      .where(and(eq(workflows.tenant_id, ctx.tenant_id), eq(workflows.id, workflow_id)));
    const draft: DraftDocument = { workflow: { name: "stub", steps: [] } };
    const [conversation] = await ctx.testDb.db
      .insert(conversations)
      .values({ tenant_id: ctx.tenant_id, status: "active", draft })
      .returning();
    if (!conversation) throw new Error("conversation insert failed");

    const result = await runWorkflowTool.execute(
      buildToolCtx({ conversation_id: conversation.id, draft, setDraft: async () => {} }),
      runWorkflowTool.inputSchema.parse({
        workflow: workflow_id,
        environment: "dev",
        input: { date: "approved input" },
        expected_workflow_version_id: version_id,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({
      error_code: "workflow_version_not_active",
      expected_workflow_version_id: version_id,
      current_workflow_version_id: replacement.id,
    });
    const runs = await ctx.testDb.db
      .select({ id: executions.id })
      .from(executions)
      .where(and(eq(executions.tenant_id, ctx.tenant_id), eq(executions.workflow_id, workflow_id)));
    expect(runs).toEqual([]);
  });

  test("pins the inspected version when activation changes before execution", async () => {
    const { workflow_id, version_id } = await seedWorkflow("activation-race");
    const [replacement] = await ctx.testDb.db
      .insert(workflowVersions)
      .values({
        tenant_id: ctx.tenant_id,
        workflow_id,
        version: 2,
        dag: {
          name: "Replacement",
          slug: "activation-race",
          steps: [
            {
              id: "shape",
              kind: "transform",
              language: "javascript",
              expression: "return { unexpected: true };",
            },
          ],
        },
      })
      .returning();
    if (!replacement) throw new Error("replacement insert failed");
    const draft: DraftDocument = { workflow: { name: "stub", steps: [] } };
    const [conversation] = await ctx.testDb.db
      .insert(conversations)
      .values({ tenant_id: ctx.tenant_id, status: "active", draft })
      .returning();
    if (!conversation) throw new Error("conversation insert failed");
    const result = await runWorkflowTool.execute(
      buildToolCtx({
        conversation_id: conversation.id,
        draft,
        setDraft: async () => {},
        afterWorkflowRead: async (id) => {
          await ctx.testDb.db
            .update(workflows)
            .set({ current_version_id: replacement.id })
            .where(and(eq(workflows.tenant_id, ctx.tenant_id), eq(workflows.id, id)));
        },
      }),
      runWorkflowTool.inputSchema.parse({
        workflow: workflow_id,
        input: { date: "approved input" },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ output: { date: "approved input" } });
    const runs = await ctx.testDb.db
      .select({ version: executions.workflow_version_id })
      .from(executions)
      .where(and(eq(executions.tenant_id, ctx.tenant_id), eq(executions.workflow_id, workflow_id)));
    expect(runs).toEqual([{ version: version_id }]);
  });

  for (const fixture of ["new-bound", "new-unbound", "edited-active"] as const) {
    test(`requires activation for an inert ${fixture} draft and starts no execution`, async () => {
      const saved = await saveWorkflowDraft(
        {
          tenant_id: ctx.tenant_id,
          actor_id: ctx.user_id,
          request_source: "chat",
          def: {
            name: `Activation ${fixture}`,
            slug: `activation-${fixture}`,
            steps: [
              {
                id: "shape",
                kind: "transform",
                language: "javascript",
                expression: "return { draft: true };",
              },
            ],
          },
        },
        ctx.testDb.db,
      );
      if (!saved.draft) throw new Error(saved.errors.join("; "));
      let currentVersionId: string | null = null;
      if (fixture === "edited-active") {
        const [active] = await ctx.testDb.db
          .insert(workflowVersions)
          .values({
            tenant_id: ctx.tenant_id,
            workflow_id: saved.draft.workflow_id,
            version: 2,
            dag: {
              ...saved.draft.definition,
              steps: [
                {
                  id: "shape",
                  kind: "transform",
                  language: "javascript",
                  expression: "return { old: true };",
                },
              ],
            },
          })
          .returning();
        if (!active) throw new Error("active fixture insert failed");
        currentVersionId = active.id;
        await ctx.testDb.db
          .update(workflows)
          .set({ current_version_id: active.id, lifecycle: "active" })
          .where(
            and(eq(workflows.tenant_id, ctx.tenant_id), eq(workflows.id, saved.draft.workflow_id)),
          );
      }
      const emptyDraft: DraftDocument = { workflow: { name: "stub", steps: [] } };
      const draft =
        fixture === "new-unbound"
          ? emptyDraft
          : bindPersistedWorkflow(emptyDraft, {
              kind: "workflow",
              id: saved.draft.workflow_id,
              slug: saved.draft.definition.slug ?? null,
              name: saved.draft.definition.name,
              version_id: saved.draft.version_id,
              version: saved.draft.version,
              environment: null,
              saved_at: "2026-05-01T00:00:00.000Z",
              draft_version_id: saved.draft.version_id,
              current_version_id: currentVersionId,
              persistence_kind: "draft",
            });
      const [conversation] = await ctx.testDb.db
        .insert(conversations)
        .values({ tenant_id: ctx.tenant_id, status: "active", draft })
        .returning();
      if (!conversation) throw new Error("conversation insert failed");
      let draftWrites = 0;
      const result = await runWorkflowTool.execute(
        buildToolCtx({
          conversation_id: conversation.id,
          draft,
          setDraft: async () => {
            draftWrites++;
          },
        }),
        runWorkflowTool.inputSchema.parse({
          workflow: saved.draft.workflow_id,
          execute_writes: true,
        }),
      );
      expect(result.ok).toBe(false);
      expect(result.data).toMatchObject({
        status: "failed",
        error_code: "workflow_activation_required",
        draft_version_id: saved.draft.version_id,
        current_version_id: currentVersionId,
        next_best_actions: ["dry_run_workflow"],
      });
      expect((result.data as { message: string }).message).toContain("dry_run_workflow");
      expect(draftWrites).toBe(0);
      const runs = await ctx.testDb.db
        .select({ id: executions.id })
        .from(executions)
        .where(
          and(
            eq(executions.tenant_id, ctx.tenant_id),
            eq(executions.workflow_id, saved.draft.workflow_id),
          ),
        );
      expect(runs).toEqual([]);
    });
  }

  test("refusal for an inactive draft bound only to prod connectors reviews prod from the bindings", async () => {
    const [connector] = await ctx.testDb.db
      .insert(connectors)
      .values({
        tenant_id: ctx.tenant_id,
        slug: "github-briefings-prod",
        display_name: "GitHub briefings",
        driver: "http",
        auth_type: "none",
        environment: "prod",
        base_url: "https://api.github.example.test",
      })
      .returning();
    if (!connector) throw new Error("connector insert failed");
    const saved = await saveWorkflowDraft(
      {
        tenant_id: ctx.tenant_id,
        actor_id: ctx.user_id,
        request_source: "chat",
        def: {
          name: "Prod briefing",
          slug: "prod-briefing",
          steps: [
            {
              id: "issues",
              kind: "request",
              method: "GET",
              connector_id: connector.id,
              path: "/repos/acme/app/issues",
            },
          ],
        },
      },
      ctx.testDb.db,
    );
    if (!saved.draft) throw new Error(saved.errors.join("; "));
    const draft = bindPersistedWorkflow(
      { workflow: { name: "stub", steps: [] } },
      {
        kind: "workflow",
        id: saved.draft.workflow_id,
        slug: saved.draft.definition.slug ?? null,
        name: saved.draft.definition.name,
        version_id: saved.draft.version_id,
        version: saved.draft.version,
        environment: null,
        saved_at: "2026-05-01T00:00:00.000Z",
        draft_version_id: saved.draft.version_id,
        current_version_id: null,
        persistence_kind: "draft",
      },
    );
    const [conversation] = await ctx.testDb.db
      .insert(conversations)
      .values({ tenant_id: ctx.tenant_id, status: "active", draft })
      .returning();
    if (!conversation) throw new Error("conversation insert failed");
    const result = await runWorkflowTool.execute(
      buildToolCtx({ conversation_id: conversation.id, draft, setDraft: async () => {} }),
      runWorkflowTool.inputSchema.parse({ workflow: saved.draft.workflow_id }),
    );
    expect(result.ok).toBe(false);
    const data = result.data as {
      error_code: string;
      environment?: string;
      environment_source?: string;
      automation_review?: {
        saved_change?: {
          environment: string;
          environment_source?: string;
          review: { issues?: Array<{ code: string }> };
        } | null;
      };
    };
    expect(data).toMatchObject({
      error_code: "workflow_activation_required",
      environment: "prod",
      environment_source: "bindings",
    });
    expect((result.data as { message: string }).message).toContain(
      "PROD follows from the connector bindings",
    );
    expect(data.automation_review?.saved_change).toMatchObject({
      environment: "prod",
      environment_source: "bindings",
    });
    expect(
      (data.automation_review?.saved_change?.review.issues ?? []).map((issue) => issue.code),
    ).not.toContain("environment_mismatch");
  });

  test("run_workflow on an active workflow without an environment keeps the dev default", async () => {
    const { workflow_id } = await seedWorkflow("default-environment");
    const draft: DraftDocument = { workflow: { name: "stub", steps: [] } };
    const [conversation] = await ctx.testDb.db
      .insert(conversations)
      .values({ tenant_id: ctx.tenant_id, status: "active", draft })
      .returning();
    if (!conversation) throw new Error("conversation insert failed");
    const result = await runWorkflowTool.execute(
      buildToolCtx({ conversation_id: conversation.id, draft, setDraft: async () => {} }),
      runWorkflowTool.inputSchema.parse({ workflow: workflow_id, input: { date: "today" } }),
    );
    expect(result.ok).toBe(true);
    const runs = await ctx.testDb.db
      .select({ mode: executions.execution_mode })
      .from(executions)
      .where(and(eq(executions.tenant_id, ctx.tenant_id), eq(executions.workflow_id, workflow_id)));
    expect(runs).toEqual([{ mode: "dev" }]);
  });
});
