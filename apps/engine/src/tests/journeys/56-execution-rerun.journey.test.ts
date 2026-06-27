// User story: As an operator, after a fix or a transient failure I
// want to rerun an execution faithfully — same workflow version, same
// input — and see the lineage between the original and the rerun.
// Acceptance criteria:
//   - AC1: POST /v1/executions/{id}/rerun reruns with the ORIGINAL
//          persisted input (the executions.input column) and returns a
//          completed run.
//   - AC2: the rerun row carries parent_execution_id = original id and
//          source_ref.rerun_of, and GET /v1/executions?parent_execution_id=
//          returns the lineage chain.
//   - AC3: the rerun pins the original workflow_version_id even after
//          the workflow gains a new version.
//   - AC4: body.input overrides the original input.
//   - AC5: a draft-source execution yields 409 with a remediation hint.
//   - AC6: unknown id yields 404.
// Spec refs: docs/concepts/workflows.md

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createJourneyCtx,
  JOURNEY_HOOK_TIMEOUT,
  type JourneyCtx,
  journeyFetch,
  seedWorkflow,
} from "./setup.ts";

let ctx: JourneyCtx;
let workflowId = "";
let versionId = "";
let originalId = "";

beforeAll(async () => {
  ctx = await createJourneyCtx("execution-rerun");
  const wf = await seedWorkflow(ctx, {
    slug: "rerun-wf",
    name: "Rerun Wf",
    // Echo the input so AC1/AC4 can assert on the output.
    steps: [
      { kind: "transform", id: "echo", language: "javascript", expression: "return input.input;" },
    ],
  });
  workflowId = wf.id;
  versionId = wf.version_id;

  const run = await journeyFetch(ctx, "/v1/executions", {
    method: "POST",
    body: JSON.stringify({
      source: "saved",
      workflow_id: workflowId,
      input: { greeting: "original" },
    }),
  });
  expect(run.status).toBe(200);
  const body = (await run.json()) as { execution_id: string };
  originalId = body.execution_id;
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("journey 56: execution rerun with lineage", () => {
  let rerunId = "";

  test(
    "AC1+AC2: rerun reuses the original input and links the lineage",
    async () => {
      const res = await journeyFetch(ctx, `/v1/executions/${originalId}/rerun`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        execution_id: string;
        status: string;
        output: unknown;
      };
      rerunId = body.execution_id;
      expect(body.status).toBe("succeeded");
      expect(body.output).toMatchObject({ greeting: "original" });

      const detail = await journeyFetch(ctx, `/v1/executions/${rerunId}`);
      const row = (await detail.json()) as {
        parent_execution_id: string | null;
        source_ref: Record<string, unknown> | null;
        input: unknown;
      };
      expect(row.parent_execution_id).toBe(originalId);
      expect(row.source_ref).toMatchObject({ rerun_of: originalId });
      expect(row.input).toMatchObject({ greeting: "original" });

      const lineage = await journeyFetch(
        ctx,
        `/v1/executions?parent_execution_id=${encodeURIComponent(originalId)}`,
      );
      const list = (await lineage.json()) as { items: Array<{ id: string }> };
      expect(list.items.some((e) => e.id === rerunId)).toBe(true);
    },
    JOURNEY_HOOK_TIMEOUT,
  );

  test(
    "AC3: rerun pins the original workflow version after a new version lands",
    async () => {
      // Rotate the workflow to a new version directly (same pattern as
      // seedWorkflow) so current_version_id moves past the original.
      const { workflows, workflowVersions } = await import("../../db/schema/index.ts");
      const { eq } = await import("drizzle-orm");
      const [v2] = await ctx.db
        .insert(workflowVersions)
        .values({
          tenant_id: ctx.tenantId,
          workflow_id: workflowId,
          version: 2,
          dag: {
            name: "Rerun Wf",
            slug: "rerun-wf",
            steps: [
              {
                kind: "transform",
                id: "echo",
                language: "javascript",
                expression: `return "v2";`,
              },
            ],
          },
        })
        .returning();
      if (!v2) throw new Error("failed to insert v2");
      await ctx.db
        .update(workflows)
        .set({ current_version_id: v2.id })
        .where(eq(workflows.id, workflowId));

      const res = await journeyFetch(ctx, `/v1/executions/${originalId}/rerun`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { execution_id: string; output: unknown };
      // Still the v1 echo behavior, not "v2".
      expect(body.output).toMatchObject({ greeting: "original" });

      const detail = await journeyFetch(ctx, `/v1/executions/${body.execution_id}`);
      const row = (await detail.json()) as { workflow_version_id: string | null };
      expect(row.workflow_version_id).toBe(versionId);
    },
    JOURNEY_HOOK_TIMEOUT,
  );

  test(
    "AC4: body.input overrides the original",
    async () => {
      const res = await journeyFetch(ctx, `/v1/executions/${originalId}/rerun`, {
        method: "POST",
        body: JSON.stringify({ input: { greeting: "override" } }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { output: unknown };
      expect(body.output).toMatchObject({ greeting: "override" });
    },
    JOURNEY_HOOK_TIMEOUT,
  );

  test(
    "AC5: draft-source execution yields 409 + hint",
    async () => {
      const draftRun = await journeyFetch(ctx, "/v1/executions", {
        method: "POST",
        body: JSON.stringify({
          source: "draft",
          definition: {
            name: "Inline Draft",
            slug: "inline-draft",
            steps: [
              { kind: "transform", id: "t", language: "javascript", expression: `return "x";` },
            ],
          },
        }),
      });
      expect(draftRun.status).toBe(200);
      const draftBody = (await draftRun.json()) as { execution_id: string };

      const res = await journeyFetch(ctx, `/v1/executions/${draftBody.execution_id}/rerun`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(409);
      const err = (await res.json()) as { code: string; hint?: string };
      expect(err.code).toBe("conflict");
      expect(err.hint ?? "").toContain("re-POST");
    },
    JOURNEY_HOOK_TIMEOUT,
  );

  test("AC6: unknown id yields 404", async () => {
    const res = await journeyFetch(
      ctx,
      "/v1/executions/00000000-0000-0000-0000-000000000000/rerun",
      { method: "POST", body: JSON.stringify({}) },
    );
    expect(res.status).toBe(404);
  });
});
