// run_workflow → build_workflow redirect contract.
//
// When the model calls run_workflow with no persisted target, the error must
// route by intent:
//   - NO draft steps  → the user is AUTHORING; next_best_actions points at
//     build_workflow / propose_step (NOT save_workflow_draft, which needs a
//     draft that doesn't exist). Without this, the model retried run_workflow
//     with variant args until the loop-detector aborted the turn (~150k
//     tokens/turn) — observed in prod across three separate conversations.
//   - draft WITH steps → the author just needs to commit; point at
//     dry_run_workflow / save_workflow_draft.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { tenants, workflows, workflowVersions } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { adminPrincipal } from "../../../test-helpers/principals.ts";
import { runWorkflowTool } from "../generated/writes/run-workflow.ts";
import type { ToolContext } from "../index.ts";

let ctx: TestDb;
let tenant_id: string;

beforeAll(async () => {
  ctx = await createTestDb("run_workflow_build_redirect");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-rwbr", display_name: "T" })
    .returning();
  tenant_id = t!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

// biome-ignore lint/suspicious/noExplicitAny: minimal draft stub for the gate test
function makeCtx(draft: any): ToolContext {
  return {
    db: ctx.db,
    tenant_id,
    conversation_id: crypto.randomUUID(), // allow-random: test-only ctx id
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({ tenant_id, actor_id: null, db: ctx.db }),
    getDraft: () => draft,
    setDraft: async () => {},
  };
}

describe("run_workflow — authoring-intent redirect", () => {
  test("no draft + no target → redirects to author_workflow, not save_workflow_draft", async () => {
    const result = await runWorkflowTool.execute(
      makeCtx({ workflow: { name: "", steps: [] } }),
      {},
    );
    expect(result.ok).toBe(false);
    const data = result.data as {
      error_code: string;
      next_best_actions: string[];
      message: string;
    };
    expect(data.error_code).toBe("workflow_not_persisted");
    expect(data.next_best_actions).toContain("author_workflow");
    // Must NOT steer to save_workflow_draft when there is nothing to save.
    expect(data.next_best_actions).not.toContain("save_workflow_draft");
    expect(data.message.toLowerCase()).toContain("author_workflow");
  });

  test("draft WITH steps + no persisted target → redirects to commit, not build", async () => {
    const draft = {
      workflow: {
        name: "wip",
        steps: [
          {
            id: "s1",
            kind: "transform",
            expression: "return input.input;",
            language: "javascript",
          },
        ],
      },
    };
    const result = await runWorkflowTool.execute(makeCtx(draft), {});
    expect(result.ok).toBe(false);
    const data = result.data as { error_code: string; next_best_actions: string[] };
    expect(data.error_code).toBe("workflow_not_persisted");
    expect(data.next_best_actions).toContain("save_workflow_draft");
    expect(data.next_best_actions).toContain("dry_run_workflow");
    expect(data.next_best_actions).not.toContain("author_workflow");
  });
});

describe("run_workflow — a version stored in an earlier format", () => {
  test("is refused by its name, not as a run that failed", async () => {
    const [workflow] = await ctx.db
      .insert(workflows)
      .values({ tenant_id, slug: "legacy-run", name: "Legacy run", lifecycle: "active" })
      .returning();
    if (!workflow) throw new Error("workflow fixture");
    const [version] = await ctx.db
      .insert(workflowVersions)
      .values({
        tenant_id,
        workflow_id: workflow.id,
        version: 1,
        // A transform language the schema no longer knows.
        dag: {
          name: "Legacy run",
          steps: [{ id: "old", kind: "transform", language: "jsonata", expression: "$" }],
        },
      })
      .returning();
    if (!version) throw new Error("version fixture");
    await ctx.db
      .update(workflows)
      .set({ current_version_id: version.id })
      .where(and(eq(workflows.tenant_id, tenant_id), eq(workflows.id, workflow.id)));

    const result = await runWorkflowTool.execute(
      { ...makeCtx({ workflow: { name: "", steps: [] } }), principal: adminPrincipal(tenant_id) },
      { workflow: "legacy-run", execute_writes: false },
    );
    expect(result.ok).toBe(false);
    const data = result.data as { error_code: string; message: string; execution_id?: string };
    expect(data.error_code).toBe("workflow_version_legacy");
    expect(data.message).toContain("earlier definition format");
    // Nothing ran: there is no execution to point at.
    expect(data.execution_id).toBeUndefined();
  });
});
