// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal runtime placeholder is the workflow contract.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { tenants, workflows, workflowVersions } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { previewWorkflowAuthority } from "../execution-authorities.ts";
import { GMAIL_SEND_TARGET } from "../report-delivery-boundary.ts";

let ctx: TestDb;
let tenantId: string;
let counter = 0;

beforeAll(async () => {
  ctx = await createTestDb("outbox_delivery");
  const [tenant] = await ctx.db
    .insert(tenants)
    .values({ slug: "outbox-delivery", display_name: "Outbox delivery" })
    .returning();
  if (!tenant) throw new Error("missing tenant");
  tenantId = tenant.id;
});
afterAll(async () => {
  await ctx.cleanup();
});

const profile = {
  kind: "gmail_outbox",
  source_step_id: "next_mail",
  recipient_field: "recipient",
  item_id_field: "id",
  from: "workshops@example.test",
  content_type: "text/plain",
  max_body_bytes: 4096,
  max_per_day: 50,
};
const readNext = {
  id: "next_mail",
  kind: "request",
  method: "GET",
  url: "https://worker.example.test/mail-outbox/next",
};
const compose = {
  id: "compose",
  kind: "transform",
  language: "javascript",
  expression: "return { raw: '' };",
};
const send = {
  id: "send_email",
  kind: "request",
  method: "POST",
  url: GMAIL_SEND_TARGET,
  max_retries: 0,
  outbox_delivery: profile,
  body: { raw: "${scope.compose.data.raw}" },
};

async function preview(dag: Record<string, unknown>) {
  const slug = `outbox-${++counter}`;
  const [workflow] = await ctx.db
    .insert(workflows)
    .values({ tenant_id: tenantId, slug, name: slug, lifecycle: "draft" })
    .returning();
  if (!workflow) throw new Error("missing workflow");
  const [version] = await ctx.db
    .insert(workflowVersions)
    .values({
      tenant_id: tenantId,
      workflow_id: workflow.id,
      version: 1,
      dag: { name: slug, ...dag },
    })
    .returning();
  if (!version) throw new Error("missing version");
  return previewWorkflowAuthority(
    {
      tenant_id: tenantId,
      workflow_id: workflow.id,
      workflow_version_id: version.id,
      execution_environment: "prod",
    },
    ctx.db,
  );
}

test("a sensitive workflow that mails the queued recipient can be approved for recurring runs", async () => {
  const result = await preview({
    execution_privacy: "sensitive",
    steps: [readNext, compose, send],
  });
  expect(result.manifest.issues).toEqual([]);
  expect(result.eligible_for_repeated_runs).toBe(true);
  expect(result.preparation_required).toBe(false);
  expect(result.manifest.effects.find((effect) => effect.step_id === "send_email")).toMatchObject({
    outbox_delivery: profile,
  });
});

test("without sensitive privacy, with a missing or later source, nothing can be approved", async () => {
  for (const dag of [
    { steps: [readNext, compose, send] },
    {
      execution_privacy: "sensitive",
      steps: [compose, send, readNext],
    },
    {
      execution_privacy: "sensitive",
      steps: [
        { ...readNext, url: "https://worker.example.test/${input.queue}/next" },
        compose,
        send,
      ],
    },
  ]) {
    const result = await preview(dag);
    expect(result.eligible_for_repeated_runs).toBe(false);
  }
});
