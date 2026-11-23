import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { workflows, workflowVersions } from "../../db/schema/index.ts";
import {
  app,
  browserHeaders,
  ctx,
  fixture,
  setupWorkflowAuthorities,
} from "./workflow-authorities-fixtures.ts";

setupWorkflowAuthorities();

const verdict = { type: "object", properties: { category: { type: "string" } } };

async function approved() {
  const f = await fixture();
  const granted = await app.request(`${f.base}/execution-authorities`, {
    method: "POST",
    headers: browserHeaders,
    body: JSON.stringify({ ...f.body, valid_until: null, max_runs: null }),
  });
  expect(granted.status).toBe(201);
  const [first] = await ctx.db
    .select({ dag: workflowVersions.dag })
    .from(workflowVersions)
    .where(eq(workflowVersions.id, f.version.id));
  const dag = first?.dag as { name: string; steps: unknown[] };
  await ctx.db
    .update(workflows)
    .set({ current_version_id: f.version.id, lifecycle: "active" })
    .where(eq(workflows.id, f.workflow.id));
  const insertVersion = async (version: number, steps: unknown[]) => {
    const [row] = await ctx.db
      .insert(workflowVersions)
      .values({
        tenant_id: f.workflow.tenant_id,
        workflow_id: f.workflow.id,
        version,
        dag: { ...dag, steps: [...dag.steps, ...steps] },
      })
      .returning();
    if (!row) throw new Error("missing version");
    return row;
  };
  const preview = async (id: string) =>
    (await (
      await app.request(`${f.base}/versions/${id}/authority-preview`, { headers: browserHeaders })
    ).json()) as {
      boundary_growth?: Array<{ kind: string; item?: string }>;
      approval_carries_over?: boolean;
      effect_changes?: Array<{ step_id: string; change: string; model_call?: true }>;
      manifest: { model_calls?: Array<{ step_id: string; data_paths: string[] }> };
    };
  return { f, insertVersion, preview };
}

test("adding a model step to an approved workflow asks for a new approval", async () => {
  const { insertVersion, preview } = await approved();
  const next = await insertVersion(2, [
    { id: "classify", kind: "model", prompt: "Sort ${input.text}", output_schema: verdict },
  ]);
  const body = await preview(next.id);
  expect(body.manifest.model_calls).toEqual([
    expect.objectContaining({ step_id: "classify", data_paths: ["input.text"] }),
  ]);
  expect(body.boundary_growth).toMatchObject([{ kind: "new_model_call", item: "classify" }]);
  expect(body.approval_carries_over).toBe(false);
  expect(body.effect_changes?.filter((entry) => entry.model_call)).toMatchObject([
    { step_id: "classify", change: "added" },
  ]);
  expect(body.effect_changes?.find((entry) => entry.step_id === "send")?.change).toBe("unchanged");
});

test("an approved model step carries over when only its wording changes", async () => {
  const model = {
    id: "classify",
    kind: "model",
    prompt: "Sort ${input.text}",
    output_schema: verdict,
  };
  const { f, insertVersion, preview } = await approved();
  const withModel = await insertVersion(2, [model]);
  await ctx.db
    .update(workflows)
    .set({ current_version_id: withModel.id })
    .where(eq(workflows.id, f.workflow.id));
  const ownPreview = await app.request(`${f.base}/versions/${withModel.id}/authority-preview`, {
    headers: browserHeaders,
  });
  const own = (await ownPreview.json()) as { digest: string };
  const granted = await app.request(`${f.base}/execution-authorities`, {
    method: "POST",
    headers: browserHeaders,
    body: JSON.stringify({
      ...f.body,
      valid_until: null,
      max_runs: null,
      workflow_version_id: withModel.id,
      expected_manifest_digest: own.digest,
    }),
  });
  expect(granted.status).toBe(201);
  const reworded = await insertVersion(3, [
    { ...model, prompt: "Please sort this message: ${input.text}" },
  ]);
  expect(await preview(reworded.id)).toMatchObject({
    boundary_growth: [],
    approval_carries_over: true,
  });
  const wider = await insertVersion(4, [
    { ...model, prompt: "Sort ${input.text} for ${input.customer}" },
  ]);
  expect((await preview(wider.id)).boundary_growth).toMatchObject([
    { kind: "new_model_call", item: "classify" },
  ]);
});
