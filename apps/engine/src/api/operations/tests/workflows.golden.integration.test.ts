import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, asc, eq } from "drizzle-orm";
import {
  getWorkflowTool,
  listWorkflowsTool,
} from "../../../conversations/tools/engine-api/workflows.ts";
import { findWorkflowTool } from "../../../conversations/tools/find-workflow.ts";
import type { ToolContext } from "../../../conversations/tools/index.ts";
import { auditLog, users, workflows, workflowVersions } from "../../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../http/tests/setup.ts";
import { createDeterministicHexFactory } from "../../../test-helpers/determinism/ids.ts";
import { emptyRoleId } from "../../../test-helpers/roles.ts";
import { makeToolCtx, seedTimestamp, seedUuid, seedWorkflow } from "../../../test-helpers/seed.ts";
import { WorkflowDefSchema } from "../../../workflows/index.ts";

const GOLDEN_PATH = new URL("./fixtures/workflows.golden.json", import.meta.url).pathname;
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, string>;
const actual: Record<string, string> = {};

let ctx: HttpTestServer;
let deniedKey: string;
let notionId: string;
let mailId: string;
let patchId: string;
const MISSING = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";

function normalize(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll(ctx.tenantId, "<tenant>")
    .replace(/"20(2[4-9]|[3-9]\d)-\d\d-\d\dT[\d:.]+Z"/g, '"<now>"')
    .replace(/"trace_id":"[^"]*"/g, '"trace_id":"<trace>"')
    .replace(/"request_id":"[^"]*"/g, '"request_id":"<request>"')
    .replace(/"audit_trace_id":"[^"]*"/g, '"audit_trace_id":"<trace>"')
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
  key = ctx.apiKey,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function toolCtx(): ToolContext {
  return makeToolCtx({ db: ctx.db, tenant_id: ctx.tenantId });
}

beforeAll(async () => {
  ctx = await createHttpTestServer("operations_workflows_golden");
  const notion = await seedWorkflow(ctx.db, {
    tenant_id: ctx.tenantId,
    id: seedUuid("workflow", 1),
    created_at: seedTimestamp(1),
    updated_at: seedTimestamp(1),
    version: { id: seedUuid("workflow_version", 1), created_at: seedTimestamp(1) },
    slug: "notion-sync",
    name: "Notion sync",
    description: "Copies Notion pages into the knowledge base.",
    category: "notion",
  });
  const mail = await seedWorkflow(ctx.db, {
    tenant_id: ctx.tenantId,
    id: seedUuid("workflow", 2),
    created_at: seedTimestamp(2),
    updated_at: seedTimestamp(2),
    version: { id: seedUuid("workflow_version", 2), created_at: seedTimestamp(2) },
    slug: "daily-mail",
    name: "Daily mail",
    def: WorkflowDefSchema.parse({
      name: "Daily mail",
      slug: "daily-mail",
      trigger: { kind: "schedule", cron: "0 7 * * *" },
      steps: [{ id: "noop", kind: "transform", expression: "return 1;" }],
    }),
  });
  const patch = await seedWorkflow(ctx.db, {
    tenant_id: ctx.tenantId,
    id: seedUuid("workflow", 3),
    created_at: seedTimestamp(3),
    updated_at: seedTimestamp(3),
    version: { id: seedUuid("workflow_version", 3), created_at: seedTimestamp(3) },
    slug: "patch-target",
    name: "Patch target",
  });
  notionId = notion.workflow.id;
  mailId = mail.workflow.id;
  patchId = patch.workflow.id;
  const [draft] = await ctx.db
    .insert(workflowVersions)
    .values({
      tenant_id: ctx.tenantId,
      workflow_id: notionId,
      version: 2,
      dag: WorkflowDefSchema.parse({
        name: "Notion sync",
        slug: "notion-sync",
        steps: [{ id: "draft", kind: "transform", expression: "return 2;" }],
      }),
      created_at: new Date("2023-11-14T22:13:20.000Z"),
    })
    .returning();
  if (!draft) throw new Error("draft version insert returned no row");
  await ctx.db
    .update(workflows)
    .set({ draft_version_id: draft.id })
    .where(eq(workflows.id, notionId));
  const [denied] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "denied-operations@test.local",
      role_id: await emptyRoleId(ctx.db, ctx.tenantId),
    })
    .returning();
  if (!denied) throw new Error("denied user insert returned no row");
  const rand = createDeterministicHexFactory(0x60_1d)(16);
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
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("workflow operations keep their HTTP responses byte for byte", () => {
  test("list", async () => {
    record("http.list", await http("GET", "/v1/workflows"));
    record("http.list.page", await http("GET", "/v1/workflows?limit=1&offset=1"));
    record("http.list.category", await http("GET", "/v1/workflows?category=notion"));
    record("http.list.invalid", await http("GET", "/v1/workflows?limit=0"));
  });

  test("get", async () => {
    record("http.get", await http("GET", `/v1/workflows/${notionId}`));
    record("http.get.trigger", await http("GET", `/v1/workflows/${mailId}`));
    record("http.get.missing", await http("GET", `/v1/workflows/${MISSING}`));
    record("http.get.invalid", await http("GET", "/v1/workflows/not-a-uuid"));
  });

  test("permission is checked before the body is validated", async () => {
    record("http.denied.list", await http("GET", "/v1/workflows", undefined, deniedKey));
    record("http.denied.get", await http("GET", `/v1/workflows/${notionId}`, undefined, deniedKey));
    record(
      "http.denied.metadata",
      await http("PATCH", `/v1/workflows/${patchId}/metadata`, { name: "" }, deniedKey),
    );
  });

  test("update metadata", async () => {
    record(
      "http.metadata",
      await http("PATCH", `/v1/workflows/${patchId}/metadata`, {
        name: "Patched target",
        category: "ops",
        description: "Patched by the golden test.",
      }),
    );
    record(
      "http.metadata.noop",
      await http("PATCH", `/v1/workflows/${patchId}/metadata`, { name: "Patched target" }),
    );
    record(
      "http.metadata.slug-conflict",
      await http("PATCH", `/v1/workflows/${patchId}/metadata`, { slug: "notion-sync" }),
    );
    record(
      "http.metadata.bad-slug",
      await http("PATCH", `/v1/workflows/${patchId}/metadata`, { slug: "Not A Slug" }),
    );
    record(
      "http.metadata.accept-mismatch",
      await http("PATCH", `/v1/workflows/${patchId}/metadata`, { accept_description: "x" }),
    );
    record("http.metadata.empty", await http("PATCH", `/v1/workflows/${patchId}/metadata`, {}));
    record(
      "http.metadata.missing",
      await http("PATCH", `/v1/workflows/${MISSING}/metadata`, { name: "Nobody" }),
    );
    record(
      "http.metadata.archive",
      await http("PATCH", `/v1/workflows/${patchId}/metadata`, { lifecycle: "archived" }),
    );
    const trail = await ctx.db
      .select({
        action: auditLog.action,
        actor_type: auditLog.actor_type,
        resource_type: auditLog.resource_type,
        result: auditLog.result,
        metadata: auditLog.metadata,
      })
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.resource_id, patchId)))
      .orderBy(asc(auditLog.ts), asc(auditLog.action));
    record("http.metadata.audit", trail);
  });
});

describe("workflow tools keep their results byte for byte", () => {
  test("list_workflows", async () => {
    record("tool.list", await listWorkflowsTool.execute(toolCtx(), {}));
    record("tool.list.page", await listWorkflowsTool.execute(toolCtx(), { limit: 1, offset: 1 }));
    record(
      "tool.list.category",
      await listWorkflowsTool.execute(toolCtx(), { category: "notion" }),
    );
    record("tool.list.status", await listWorkflowsTool.execute(toolCtx(), { status: "archived" }));
  });

  test("get_workflow", async () => {
    record("tool.get.id", await getWorkflowTool.execute(toolCtx(), { id: mailId }));
    record("tool.get.slug", await getWorkflowTool.execute(toolCtx(), { slug: "notion-sync" }));
    record(
      "tool.get.draft",
      await getWorkflowTool.execute(toolCtx(), { id: notionId, include_draft: true }),
    );
    record(
      "tool.get.no-draft",
      await getWorkflowTool.execute(toolCtx(), { id: mailId, include_draft: true }),
    );
    record("tool.get.missing", await getWorkflowTool.execute(toolCtx(), { id: MISSING }));
  });

  test("find_workflow", async () => {
    record("tool.find.id", await findWorkflowTool.execute(toolCtx(), { id: notionId }));
    record("tool.find.query", await findWorkflowTool.execute(toolCtx(), { query: "notion" }));
    record("tool.find.all", await findWorkflowTool.execute(toolCtx(), { query: "*", limit: 2 }));
    record("tool.find.missing", await findWorkflowTool.execute(toolCtx(), { id: MISSING }));
    record("tool.find.invalid-id", await findWorkflowTool.execute(toolCtx(), { id: "briefing" }));
  });

  test("the golden file has no stale entries", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });
});
