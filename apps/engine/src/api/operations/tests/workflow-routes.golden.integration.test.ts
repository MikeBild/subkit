import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { auditLog, users } from "../../../db/schema/index.ts";
import {
  browserSessionHeaders,
  createHttpTestServer,
  type HttpTestServer,
} from "../../../http/tests/setup.ts";
import { createDeterministicHexFactory } from "../../../test-helpers/determinism/ids.ts";
import { emptyRoleId } from "../../../test-helpers/roles.ts";
import {
  seedConnector,
  seedTimestamp,
  seedUuid,
  seedWorkflow,
} from "../../../test-helpers/seed.ts";
import { WorkflowDefSchema } from "../../../workflows/index.ts";

const GOLDEN_PATH = new URL("./fixtures/workflow-routes.golden.json", import.meta.url).pathname;
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, string>;
const actual: Record<string, string> = {};

let ctx: HttpTestServer;
let deniedKey: string;
let browser: Record<string, string>;
let scheduleTargetId: string;
let archivedId: string;
let updateTargetId: string;
let deleteTargetId: string;
let authorityWorkflowId: string;
let authorityVersionId: string;
const MISSING = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";
const CHOSEN = "5eed0002-0000-4000-8000-0000000000c1";

function normalize(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll(ctx.tenantId, "<tenant>")
    .replaceAll(ctx.userId, "<user>")
    .replace(/"20(2[4-9]|[3-9]\d)-\d\d-\d\dT[\d:.]+Z"/g, '"<now>"')
    .replace(/"trace_id":"[^"]*"/g, '"trace_id":"<trace>"')
    .replace(/"request_id":"[^"]*"/g, '"request_id":"<request>"')
    .replace(/"audit_trace_id":"[^"]*"/g, '"audit_trace_id":"<trace>"')
    .replace(/"prefix":"wf_live_[^"]*"/g, '"prefix":"<key>"')
    .replace(/"(digest|effect_manifest_digest)":"[0-9a-f]{64}"/g, '"$1":"<tenant-digest>"')
    .replace(
      /\b(?!5eed|0f0f0f0f)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g,
      "<uuid>",
    );
}

function record(name: string, value: unknown): void {
  actual[name] = normalize(value);
  expect(actual[name]).toBe(golden[name] as string);
}

async function http(
  method: string,
  path: string,
  body?: unknown,
  key: string | Record<string, string> = ctx.apiKey,
): Promise<{ status: number; body: unknown }> {
  const headers =
    typeof key === "string"
      ? { authorization: `Bearer ${key}`, "content-type": "application/json" }
      : key;
  const res = await fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function definition(name: string, expression = "return 1;") {
  return {
    name,
    slug: name,
    steps: [{ kind: "transform", id: "result", expression }],
  };
}

beforeAll(async () => {
  ctx = await createHttpTestServer("operations_workflow_routes_golden");
  const target = await seedWorkflow(ctx.db, {
    tenant_id: ctx.tenantId,
    id: seedUuid("workflow", 1),
    created_at: seedTimestamp(1),
    updated_at: seedTimestamp(1),
    version: { id: seedUuid("workflow_version", 1), created_at: seedTimestamp(1) },
    slug: "schedule-target",
    name: "Schedule target",
  });
  const archived = await seedWorkflow(ctx.db, {
    tenant_id: ctx.tenantId,
    id: seedUuid("workflow", 2),
    created_at: seedTimestamp(2),
    updated_at: seedTimestamp(2),
    version: { id: seedUuid("workflow_version", 2), created_at: seedTimestamp(2) },
    slug: "archived-target",
    name: "Archived target",
    lifecycle: "archived",
  });
  const update = await seedWorkflow(ctx.db, {
    tenant_id: ctx.tenantId,
    id: seedUuid("workflow", 3),
    created_at: seedTimestamp(3),
    updated_at: seedTimestamp(3),
    version: { id: seedUuid("workflow_version", 3), created_at: seedTimestamp(3) },
    slug: "update-target",
    name: "Update target",
    def: WorkflowDefSchema.parse({
      name: "Update target",
      slug: "update-target",
      trigger: { kind: "schedule", cron: "0 7 * * *" },
      steps: [{ id: "noop", kind: "transform", expression: "return 1;" }],
    }),
  });
  const removable = await seedWorkflow(ctx.db, {
    tenant_id: ctx.tenantId,
    id: seedUuid("workflow", 4),
    created_at: seedTimestamp(4),
    updated_at: seedTimestamp(4),
    version: { id: seedUuid("workflow_version", 4), created_at: seedTimestamp(4) },
    slug: "delete-target",
    name: "Delete target",
  });
  const connector = await seedConnector(ctx.db, {
    tenant_id: ctx.tenantId,
    id: seedUuid("connector", 1),
    slug: "authority-remote",
    display_name: "Authority remote",
    base_url: "https://example.test/api",
    created_at: seedTimestamp(5),
    updated_at: seedTimestamp(5),
  });
  const authority = await seedWorkflow(ctx.db, {
    tenant_id: ctx.tenantId,
    id: seedUuid("workflow", 5),
    created_at: seedTimestamp(6),
    updated_at: seedTimestamp(6),
    version: { id: seedUuid("workflow_version", 5), created_at: seedTimestamp(6) },
    slug: "authority-target",
    name: "Authority target",
    lifecycle: "draft",
    def: WorkflowDefSchema.parse({
      name: "Authority target",
      slug: "authority-target",
      steps: [
        {
          id: "send",
          kind: "request",
          connector_id: connector.id,
          method: "POST",
          path: "/messages",
          body: { recipient: "reviewed@example.test" },
        },
      ],
    }),
  });
  scheduleTargetId = target.workflow.id;
  archivedId = archived.workflow.id;
  updateTargetId = update.workflow.id;
  deleteTargetId = removable.workflow.id;
  authorityWorkflowId = authority.workflow.id;
  authorityVersionId = authority.version.id;
  const [denied] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "denied-workflow-routes@test.local",
      role_id: await emptyRoleId(ctx.db, ctx.tenantId),
    })
    .returning();
  if (!denied) throw new Error("denied user insert returned no row");
  const rand = createDeterministicHexFactory(0x60_2d)(16);
  deniedKey = `wf_live_${rand}`;
  await ctx.testDb.pool.query(
    "INSERT INTO subkit.api_keys (tenant_id, user_id, prefix, token_sha256, scopes) VALUES ($1, $2, $3, $4, $5::jsonb)",
    [
      ctx.tenantId,
      denied.id,
      deniedKey.slice(0, 12),
      createHash("sha256").update(deniedKey).digest("hex"),
      JSON.stringify(["*"]),
    ],
  );
  browser = await browserSessionHeaders(ctx, ctx.userId);
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("workflow routes keep their HTTP responses byte for byte", () => {
  test("schedules", async () => {
    record("http.schedules.list.empty", await http("GET", "/v1/schedules"));
    const created = await http("POST", "/v1/schedules", {
      workflow_id: scheduleTargetId,
      cron: "0 9 * * *",
      timezone: "Europe/Berlin",
      paused: true,
    });
    record("http.schedules.create", created);
    record(
      "http.schedules.upsert",
      await http("POST", "/v1/schedules", { workflow_id: scheduleTargetId, cron: "0 10 * * *" }),
    );
    record(
      "http.schedules.create.bad-cron",
      await http("POST", "/v1/schedules", { workflow_id: scheduleTargetId, cron: "nope" }),
    );
    record(
      "http.schedules.create.missing",
      await http("POST", "/v1/schedules", { workflow_id: MISSING, cron: "0 9 * * *" }),
    );
    record(
      "http.schedules.create.archived",
      await http("POST", "/v1/schedules", { workflow_id: archivedId, cron: "0 9 * * *" }),
    );
    record("http.schedules.create.invalid", await http("POST", "/v1/schedules", { cron: 1 }));
    const scheduleId = (created.body as { id: string }).id;
    record(
      "http.schedules.update",
      await http("PUT", `/v1/schedules/${scheduleId}`, { cron: "0 11 * * *", paused: true }),
    );
    record(
      "http.schedules.update.bad-cron",
      await http("PUT", `/v1/schedules/${scheduleId}`, { cron: "nope" }),
    );
    record(
      "http.schedules.update.missing",
      await http("PUT", `/v1/schedules/${MISSING}`, { paused: true }),
    );
    record("http.schedules.list", await http("GET", "/v1/schedules"));
    record(
      "http.schedules.list.filtered",
      await http("GET", `/v1/schedules?workflow_id=${archivedId}`),
    );
    record("http.schedules.delete", await http("DELETE", `/v1/schedules/${scheduleId}`));
    record("http.schedules.delete.missing", await http("DELETE", `/v1/schedules/${scheduleId}`));
  });

  test("workflow create, validate, update and delete", async () => {
    record("http.create", await http("POST", "/v1/workflows", definition("created-flow")));
    record(
      "http.create.category",
      await http("POST", "/v1/workflows", { ...definition("categorized-flow"), category: "ops" }),
    );
    record(
      "http.create.chosen-id",
      await http("POST", "/v1/workflows", { ...definition("chosen-flow"), id: CHOSEN }),
    );
    record(
      "http.create.invalid",
      await http("POST", "/v1/workflows", { name: "broken", steps: [{ kind: "unknown" }] }),
    );
    record("http.create.schema", await http("POST", "/v1/workflows", { name: 1 }));
    record(
      "http.create.recipe-unknown",
      await http("POST", "/v1/workflows", {
        ...definition("recipe-flow"),
        recipe: { vertical: "nowhere", slug: "nothing" },
      }),
    );
    record(
      "http.create.recipe-mismatch",
      await http("POST", "/v1/workflows", {
        ...definition("recipe-mismatch-flow"),
        recipe: { vertical: "solutions", slug: "webhook-to-slack" },
      }),
    );
    record("http.validate.ok", await http("POST", "/v1/workflows/validate", definition("valid")));
    record(
      "http.validate.errors",
      await http("POST", "/v1/workflows/validate", { steps: [{ kind: "transform", id: "x" }] }),
    );
    record(
      "http.update",
      await http("PUT", `/v1/workflows/${updateTargetId}`, {
        name: "Update target",
        slug: "update-target",
        category: "ops",
        steps: [{ id: "noop", kind: "transform", expression: "return 2;" }],
      }),
    );
    record(
      "http.update.invalid",
      await http("PUT", `/v1/workflows/${updateTargetId}`, {
        name: "Update target",
        steps: [{ kind: "unknown" }],
      }),
    );
    record(
      "http.update.missing",
      await http("PUT", `/v1/workflows/${MISSING}`, definition("nobody")),
    );
    record("http.update.bad-id", await http("PUT", "/v1/workflows/not-a-uuid", definition("x")));
    record("http.delete", await http("DELETE", `/v1/workflows/${deleteTargetId}`));
    record("http.delete.missing", await http("DELETE", `/v1/workflows/${deleteTargetId}`));
  });

  test("drafts and boundary proposals", async () => {
    const created = await http("POST", "/v1/workflows/drafts", {
      definition: definition("draft-flow"),
      category: "ops",
    });
    record("http.drafts.create", created);
    record(
      "http.drafts.create.invalid",
      await http("POST", "/v1/workflows/drafts", {
        definition: { name: "invalid", steps: [{ kind: "unknown" }] },
      }),
    );
    record(
      "http.drafts.create.recipe-unknown",
      await http("POST", "/v1/workflows/drafts", {
        definition: definition("draft-recipe"),
        recipe: { vertical: "nowhere", slug: "nothing" },
      }),
    );
    record(
      "http.drafts.create.recipe-mismatch",
      await http("POST", "/v1/workflows/drafts", {
        definition: definition("draft-recipe-mismatch"),
        recipe: { vertical: "solutions", slug: "webhook-to-slack" },
      }),
    );
    const draft = created.body as { workflow_id: string; version_id: string };
    const url = `/v1/workflows/${draft.workflow_id}/draft`;
    record("http.drafts.get", await http("GET", url));
    record("http.drafts.get.missing", await http("GET", `/v1/workflows/${MISSING}/draft`));
    const updated = await http("PUT", url, {
      definition: definition("draft-flow", "return 2;"),
      expected_draft_version_id: draft.version_id,
    });
    record("http.drafts.update", updated);
    record(
      "http.drafts.update.stale",
      await http("PUT", url, {
        definition: definition("draft-flow", "return 3;"),
        expected_draft_version_id: draft.version_id,
      }),
    );
    record(
      "http.drafts.update.missing",
      await http("PUT", `/v1/workflows/${MISSING}/draft`, {
        definition: definition("draft-missing"),
        expected_draft_version_id: null,
      }),
    );
    record(
      "http.drafts.update.invalid",
      await http("PUT", url, {
        definition: { name: "invalid", steps: [{ kind: "unknown" }] },
        expected_draft_version_id: (updated.body as { version_id: string }).version_id,
      }),
    );
    const proposals = `/v1/workflows/${draft.workflow_id}/boundary-proposals`;
    record("http.proposals", await http("GET", proposals));
    record(
      "http.proposals.missing",
      await http("GET", `/v1/workflows/${MISSING}/boundary-proposals`),
    );
    record(
      "http.proposals.apply.nothing",
      await http("POST", `${proposals}/apply`, {
        expected_draft_version_id: (updated.body as { version_id: string }).version_id,
      }),
    );
    record(
      "http.proposals.apply.missing",
      await http("POST", `/v1/workflows/${MISSING}/boundary-proposals/apply`, {
        expected_draft_version_id: null,
      }),
    );
    record(
      "http.proposals.apply.invalid",
      await http("POST", `${proposals}/apply`, { step_ids: [] }),
    );
  });

  test("execution authorities", async () => {
    const base = `/v1/workflows/${authorityWorkflowId}`;
    const previewPath = `${base}/versions/${authorityVersionId}/authority-preview`;
    const preview = await http("GET", previewPath);
    record("http.authority.preview", preview);
    record("http.authority.preview.prod", await http("GET", `${previewPath}?environment=prod`));
    record(
      "http.authority.preview.missing",
      await http("GET", `${base}/versions/${MISSING}/authority-preview`),
    );
    record(
      "http.authority.preview.invalid",
      await http("GET", `${previewPath}?environment=staging`),
    );
    record("http.authority.list.empty", await http("GET", `${base}/execution-authorities`));
    const reviewed = preview.body as {
      digest: string;
      suggested_bounds: { valid_from: string; valid_until: string; max_runs: number };
    };
    const granted = await http(
      "POST",
      `${base}/execution-authorities`,
      {
        workflow_version_id: authorityVersionId,
        execution_environment: "dev",
        expected_manifest_digest: reviewed.digest,
        ...reviewed.suggested_bounds,
      },
      browser,
    );
    expect(granted.status).toBe(201);
    const authorityId = (granted.body as { id: string }).id;
    record("http.authority.list", await http("GET", `${base}/execution-authorities`));
    record(
      "http.authority.list.prod",
      await http("GET", `${base}/execution-authorities?environment=prod&limit=5`),
    );
    record(
      "http.authority.list.missing",
      await http("GET", `/v1/workflows/${MISSING}/execution-authorities`),
    );
    record(
      "http.authority.list.invalid",
      await http("GET", `${base}/execution-authorities?limit=0`),
    );
    record("http.authority.get", await http("GET", `${base}/execution-authorities/${authorityId}`));
    record(
      "http.authority.get.missing",
      await http("GET", `${base}/execution-authorities/${MISSING}`),
    );
  });

  test("permission is checked before the body is validated", async () => {
    const base = `/v1/workflows/${authorityWorkflowId}`;
    const denied: [string, string, string, unknown?][] = [
      ["schedules.list", "GET", "/v1/schedules"],
      ["schedules.create", "POST", "/v1/schedules", { cron: 1 }],
      ["schedules.update", "PUT", `/v1/schedules/${MISSING}`, { cron: 1 }],
      ["schedules.delete", "DELETE", `/v1/schedules/${MISSING}`],
      ["create", "POST", "/v1/workflows", { name: 1 }],
      ["validate", "POST", "/v1/workflows/validate", { name: 1 }],
      ["update", "PUT", `/v1/workflows/${updateTargetId}`, { name: 1 }],
      ["delete", "DELETE", `/v1/workflows/${updateTargetId}`],
      ["drafts.create", "POST", "/v1/workflows/drafts", { definition: 1 }],
      ["drafts.get", "GET", `/v1/workflows/${updateTargetId}/draft`],
      ["drafts.update", "PUT", `/v1/workflows/${updateTargetId}/draft`, { definition: 1 }],
      ["proposals", "GET", `/v1/workflows/${updateTargetId}/boundary-proposals`],
      [
        "proposals.apply",
        "POST",
        `/v1/workflows/${updateTargetId}/boundary-proposals/apply`,
        { step_ids: 1 },
      ],
      [
        "authority.preview",
        "GET",
        `${base}/versions/${authorityVersionId}/authority-preview?environment=staging`,
      ],
      ["authority.list", "GET", `${base}/execution-authorities?limit=0`],
      ["authority.get", "GET", `${base}/execution-authorities/${MISSING}`],
    ];
    for (const [name, method, path, body] of denied)
      record(`http.denied.${name}`, await http(method, path, body, deniedKey));
  });

  test("audit trail", async () => {
    const rows = await ctx.db
      .select({
        action: auditLog.action,
        actor_type: auditLog.actor_type,
        actor_id: auditLog.actor_id,
        resource_type: auditLog.resource_type,
        resource_id: auditLog.resource_id,
        result: auditLog.result,
        metadata: auditLog.metadata,
      })
      .from(auditLog)
      .where(eq(auditLog.tenant_id, ctx.tenantId));
    const trail = rows.map((row) => normalize(row)).sort();
    record("http.audit", trail);
  });

  test("the golden file has no stale entries", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });
});
