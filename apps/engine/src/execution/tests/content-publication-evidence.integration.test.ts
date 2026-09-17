import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { executionSteps, workflowExecutionAuthorities } from "../../db/schema/index.ts";
import { databaseNow } from "../../test-helpers/database-clock.ts";
import { withDriverFetchForTests } from "../../test-helpers/driver-fetch.ts";
import { previewWorkflowAuthority } from "../../workflows/execution-authorities.ts";
import { admitAuthorizedWorkflowExecution } from "../authority-admission.ts";
import { runExecution } from "../engine.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./setup.ts";

const item = "00000000-0000-4000-8000-000000000001";
const revisionId = "00000000-0000-4000-8000-000000000011";
const forgedId = "00000000-0000-4000-8000-000000000099";
const origin = "https://content.example.test";
let ctx: EngineTestCtx;
let sequence = 0;
beforeAll(async () => {
  ctx = await createEngineCtx("content-publication-evidence");
});
afterAll(async () => {
  await ctx.cleanup();
});

async function fixture(dynamic = false) {
  const wf = await createWorkflowRow(ctx, {
    name: "Update one content item",
    slug: `content-evidence-${++sequence}`,
    steps: [
      {
        id: "update",
        kind: "request",
        method: "PUT",
        url: `${origin}/v1/content/${item}/revisions`,
        headers: { "Content-Type": "text/markdown; charset=utf-8" },
        // biome-ignore lint/suspicious/noTemplateCurlyInString: actual workflow interpolation
        body: dynamic ? "${input.markdown}" : "# Updated project",
        data_selector: dynamic ? undefined : "$.alternate",
        max_retries: 0,
      },
    ],
  });
  const db = ctx.testDb.db;
  const inspect = () =>
    previewWorkflowAuthority(
      {
        tenant_id: ctx.tenantId,
        workflow_id: wf.workflow_id,
        workflow_version_id: wf.version_id,
        execution_environment: "dev",
      },
      db,
    );
  const prepare = () =>
    runExecution({
      tenant_id: ctx.tenantId,
      db,
      source: { kind: "saved", workflow_id: wf.workflow_id },
      input: { markdown: "# Updated project" },
      options: { hold_writes: true, execution_mode: "dev" },
    });
  const run = async () => {
    const preview = await inspect();
    expect(preview.eligible_for_repeated_runs).toBe(true);
    const now = await databaseNow(db);
    // Exact static fixture authority; browser human-consent semantics are
    // independently covered by grant service tests. No production mutation.
    await db.insert(workflowExecutionAuthorities).values({
      tenant_id: ctx.tenantId,
      workflow_id: wf.workflow_id,
      workflow_version_id: wf.version_id,
      effect_manifest_digest: preview.digest,
      effect_manifest: { ...preview.manifest },
      target_constraints: {
        targets: preview.manifest.effects.flatMap((e) => (e.target ? [e.target] : [])),
      },
      execution_environment: "dev",
      valid_from: new Date(now.getTime() - 60_000),
      valid_until: new Date(now.getTime() + 3_600_000),
      max_runs: 1,
      created_by: item,
    });
    const admitted = await admitAuthorizedWorkflowExecution(
      {
        tenant_id: ctx.tenantId,
        workflow_id: wf.workflow_id,
        execution_environment: "dev",
        request_source: "api",
        input: {},
      },
      db,
    );
    return runExecution({
      tenant_id: ctx.tenantId,
      db,
      source: { kind: "saved", workflow_id: wf.workflow_id },
      input: {},
      options: { existing_execution_id: admitted.execution_id },
    });
  };
  const evidence = async (id: string) => {
    const [step] = await db
      .select()
      .from(executionSteps)
      .where(
        and(
          eq(executionSteps.tenant_id, ctx.tenantId),
          eq(executionSteps.execution_id, id),
          eq(executionSteps.step_key, "update"),
        ),
      );
    return step;
  };
  return { prepare, inspect, run, evidence };
}

test("held preview records fixed item evidence without publishing or creating a receipt", async () => {
  const f = await fixture(true);
  let writes = 0;
  const remote = Object.assign(
    async () => {
      writes++;
      return Response.json({ id: revisionId, alternate: { id: forgedId } }, { status: 201 });
    },
    { preconnect: () => {} },
  ) as typeof fetch;
  await withDriverFetchForTests(remote, async () => {
    const result = await f.prepare();
    expect(result.status, JSON.stringify(result.steps)).toBe("succeeded");
    const step = await f.evidence(result.execution_id);
    const extras = (step?.request_meta as { extras?: Record<string, unknown> })?.extras;
    expect(extras?.held).toBe(true);
    expect(extras?.content_revision_proposal).toEqual({ origin, item_id: item, bytes: 17 });
    expect(extras?.content_revision_receipt).toBeUndefined();
    expect(writes).toBe(0);
    // Evidence alone cannot grant repeated writes or resolve a decision.
    const review = await f.inspect();
    expect(review.eligible_for_repeated_runs).toBe(true);
    await expect(
      admitAuthorizedWorkflowExecution(
        {
          tenant_id: ctx.tenantId,
          workflow_id: review.manifest.workflow_id,
          execution_environment: "dev",
          request_source: "scheduler",
          input: {},
        },
        ctx.testDb.db,
      ),
    ).rejects.toMatchObject({ code: "execution_authority_unavailable" });
  });
});

test("receipt uses the raw provider ID even when the authored output selector substitutes another", async () => {
  const f = await fixture();
  const remote = Object.assign(
    async () => Response.json({ id: revisionId, alternate: { id: forgedId } }, { status: 201 }),
    {
      preconnect: () => {},
    },
  ) as typeof fetch;
  await withDriverFetchForTests(remote, async () => {
    const result = await f.run();
    expect(result.status, JSON.stringify(result.steps)).toBe("succeeded");
    const step = await f.evidence(result.execution_id);
    const extras = (step?.request_meta as { extras?: Record<string, unknown> })?.extras;
    expect(extras?.content_revision_receipt).toEqual({
      step_id: "update",
      origin,
      item_id: item,
      revision_id: revisionId,
    });
    expect(JSON.stringify(step?.output_preview)).toContain(forgedId);
    expect(JSON.stringify(extras)).not.toContain(forgedId);
    expect(JSON.stringify(extras)).not.toContain("Updated project");
  });
});
