import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  getConnectorTool,
  listConnectorsTool,
} from "../../../conversations/tools/engine-api/connectors.ts";
import type { ConversationTool, ToolContext } from "../../../conversations/tools/index.ts";
import { upsertCredential } from "../../../credentials/service.ts";
import { auditLog, users } from "../../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../http/tests/setup.ts";
import { createDeterministicHexFactory } from "../../../test-helpers/determinism/ids.ts";
import { emptyRoleId } from "../../../test-helpers/roles.ts";
import { makeToolCtx, seedConnector, seedTimestamp, seedUuid } from "../../../test-helpers/seed.ts";

const GOLDEN_PATH = new URL("./fixtures/connectors.golden.json", import.meta.url).pathname;
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, string>;
const actual: Record<string, string> = {};

let ctx: HttpTestServer;
let deniedKey: string;
let deniedUserId: string;
const MISSING = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";
const NOTION = seedUuid("connector", 101);
const GRAPH = seedUuid("connector", 102);
const REAUTH = seedUuid("connector", 103);
const PATCH = seedUuid("connector", 104);
const TOGGLE = seedUuid("connector", 105);
const REMOTE = seedUuid("connector", 106);

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

function descriptor(tool: ConversationTool) {
  return {
    name: tool.name,
    description: tool.description,
    use_case: tool.use_case,
    important_notes: tool.important_notes,
    category: tool.category,
    permission: tool.permission,
  };
}

async function auditFor(ids: string[]) {
  return ctx.db
    .select({
      action: auditLog.action,
      actor_type: auditLog.actor_type,
      resource_type: auditLog.resource_type,
      resource_id: auditLog.resource_id,
      result: auditLog.result,
      reason: auditLog.reason,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, ctx.tenantId), inArray(auditLog.resource_id, ids)))
    .orderBy(asc(auditLog.ts), asc(auditLog.action));
}

beforeAll(async () => {
  ctx = await createHttpTestServer("operations_connectors_golden");
  await seedConnector(ctx.db, {
    tenant_id: ctx.tenantId,
    id: NOTION,
    slug: "notion",
    display_name: "Notion",
    description: "Reads Notion pages.",
    category: "notion",
    auth_type: "header",
    base_url: "https://api.notion.test",
    config: { headers: { "notion-version": "2022-06-28" } },
    created_at: seedTimestamp(101),
    updated_at: seedTimestamp(101),
  });
  await seedConnector(ctx.db, {
    tenant_id: ctx.tenantId,
    id: GRAPH,
    slug: "graph",
    display_name: "Graph",
    driver: "graphql",
    environment: "prod",
    auth_type: "bearer",
    base_url: "https://graph.example.test/graphql",
    enabled: false,
    created_at: seedTimestamp(102),
    updated_at: seedTimestamp(102),
  });
  await seedConnector(ctx.db, {
    tenant_id: ctx.tenantId,
    id: REAUTH,
    slug: "reauth",
    display_name: "Reauth",
    auth_type: "oauth2",
    needs_reauth: true,
    auth_failed_at: seedTimestamp(110),
    auth_failed_reason: "invalid_grant",
    created_at: seedTimestamp(103),
    updated_at: seedTimestamp(103),
  });
  await seedConnector(ctx.db, {
    tenant_id: ctx.tenantId,
    id: PATCH,
    slug: "patch-target",
    display_name: "Patch target",
    created_at: seedTimestamp(104),
    updated_at: seedTimestamp(104),
  });
  await seedConnector(ctx.db, {
    tenant_id: ctx.tenantId,
    id: TOGGLE,
    slug: "toggle",
    display_name: "Toggle",
    created_at: seedTimestamp(105),
    updated_at: seedTimestamp(105),
  });
  await seedConnector(ctx.db, {
    tenant_id: ctx.tenantId,
    id: REMOTE,
    slug: "remote-mcp",
    display_name: "Remote MCP",
    driver: "mcp",
    base_url: "https://mcp.example.test/mcp",
    created_at: seedTimestamp(106),
    updated_at: seedTimestamp(106),
  });
  await upsertCredential(
    {
      tenant_id: ctx.tenantId,
      connector_id: NOTION,
      environment: "dev",
      mode: "header",
      value: { mode: "header", headers: { authorization: "Bearer golden-secret" } },
      actor_id: null,
      actor: null,
      source: "http_route",
    },
    ctx.db,
  );
  const [denied] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "denied-connectors@test.local",
      role_id: await emptyRoleId(ctx.db, ctx.tenantId),
    })
    .returning();
  if (!denied) throw new Error("denied user insert returned no row");
  deniedUserId = denied.id;
  const rand = createDeterministicHexFactory(0xc0_2d)(16);
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

describe("connector operations keep their HTTP responses byte for byte", () => {
  test("list", async () => {
    record("http.list", await http("GET", "/v1/connectors"));
    record("http.list.page", await http("GET", "/v1/connectors?limit=2&offset=1"));
    record("http.list.sort", await http("GET", "/v1/connectors?sort=name&order=desc&limit=3"));
    record("http.list.category", await http("GET", "/v1/connectors?category=notion"));
    record("http.list.driver", await http("GET", "/v1/connectors?driver=graphql"));
    record("http.list.environment", await http("GET", "/v1/connectors?environment=prod"));
    record("http.list.kind", await http("GET", "/v1/connectors?kind=oauth"));
    record("http.list.enabled", await http("GET", "/v1/connectors?enabled=false"));
    record("http.list.enabled-true", await http("GET", "/v1/connectors?enabled=true&limit=1"));
    record("http.list.not-ok", await http("GET", "/v1/connectors?health=not_ok"));
    record("http.list.q", await http("GET", "/v1/connectors?q=patch"));
    record("http.list.group", await http("GET", "/v1/connectors?group_by=category"));
    record("http.list.invalid", await http("GET", "/v1/connectors?limit=0"));
  });

  test("get", async () => {
    record("http.get", await http("GET", `/v1/connectors/${NOTION}`));
    record("http.get.reauth", await http("GET", `/v1/connectors/${REAUTH}`));
    record("http.get.missing", await http("GET", `/v1/connectors/${MISSING}`));
    record("http.get.invalid", await http("GET", "/v1/connectors/not-a-uuid"));
  });

  test("permission is checked before the request is validated", async () => {
    record("http.denied.list", await http("GET", "/v1/connectors", undefined, deniedKey));
    record("http.denied.get", await http("GET", `/v1/connectors/${NOTION}`, undefined, deniedKey));
    record("http.denied.create", await http("POST", "/v1/connectors", { name: "" }, deniedKey));
    record(
      "http.denied.patch",
      await http("PATCH", `/v1/connectors/${PATCH}`, { name: "" }, deniedKey),
    );
    record(
      "http.denied.delete",
      await http("DELETE", `/v1/connectors/${PATCH}`, undefined, deniedKey),
    );
    record(
      "http.denied.enable",
      await http("POST", `/v1/connectors/${TOGGLE}/enable`, undefined, deniedKey),
    );
    record(
      "http.denied.disable",
      await http("POST", `/v1/connectors/${TOGGLE}/disable`, undefined, deniedKey),
    );
    record("http.denied.mcp", await http("GET", "/v1/connectors/mcp", undefined, deniedKey));
    record(
      "http.denied.validate",
      await http("GET", "/v1/connectors/validate", undefined, deniedKey),
    );
    const denials = await ctx.db
      .select({
        action: auditLog.action,
        resource_type: auditLog.resource_type,
        resource_id: auditLog.resource_id,
        result: auditLog.result,
        reason: auditLog.reason,
        metadata: auditLog.metadata,
      })
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.actor_id, deniedUserId)))
      .orderBy(asc(auditLog.ts), asc(auditLog.action));
    record("http.denied.audit", denials);
  });

  test("create and delete", async () => {
    record(
      "http.create",
      await http("POST", "/v1/connectors", {
        name: "Created",
        slug: "created",
        driver: "http",
        base_url: "https://created.example.test",
      }),
    );
    record("http.create.invalid", await http("POST", "/v1/connectors", { name: "" }));
    const created = (await http("GET", "/v1/connectors?q=created")).body as {
      items: { id: string }[];
    };
    const createdId = created.items[0]?.id ?? MISSING;
    record("http.delete", await http("DELETE", `/v1/connectors/${createdId}`));
    record("http.delete.missing", await http("DELETE", `/v1/connectors/${MISSING}`));
    record("http.create.audit", await auditFor([createdId]));
  });

  test("update", async () => {
    record(
      "http.patch",
      await http("PATCH", `/v1/connectors/${PATCH}`, {
        name: "Patched target",
        category: "ops",
        description: "Patched by the golden test.",
      }),
    );
    record("http.patch.empty", await http("PATCH", `/v1/connectors/${PATCH}`, {}));
    record(
      "http.patch.accept-mismatch",
      await http("PATCH", `/v1/connectors/${PATCH}`, { accept_description: true }),
    );
    record(
      "http.patch.accept-stale",
      await http("PATCH", `/v1/connectors/${PATCH}`, {
        description: "Some other description.",
        accept_description: true,
      }),
    );
    record(
      "http.patch.accept-exact",
      await http("PATCH", `/v1/connectors/${PATCH}`, {
        description: "Patched by the golden test.",
        accept_description: true,
      }),
    );
    record(
      "http.patch.template-conflict",
      await http("PATCH", `/v1/connectors/${PATCH}`, {
        clear_template_binding: true,
        template_slug: "github",
      }),
    );
    record(
      "http.patch.bad-url",
      await http("PATCH", `/v1/connectors/${PATCH}`, { base_url: "not a url" }),
    );
    record(
      "http.patch.missing",
      await http("PATCH", `/v1/connectors/${MISSING}`, { name: "Nobody" }),
    );
    record("http.patch.invalid-id", await http("PATCH", "/v1/connectors/nope", { name: "x" }));
    record("http.patch.audit", await auditFor([PATCH]));
  });

  test("enable and disable", async () => {
    record("http.disable", await http("POST", `/v1/connectors/${TOGGLE}/disable`));
    record("http.enable", await http("POST", `/v1/connectors/${TOGGLE}/enable`));
    record("http.enable.missing", await http("POST", `/v1/connectors/${MISSING}/enable`));
    record("http.disable.invalid", await http("POST", "/v1/connectors/nope/disable"));
    record("http.toggle.audit", await auditFor([TOGGLE]));
  });
});

describe("connector runtime operations keep their HTTP responses byte for byte", () => {
  test("runtime", async () => {
    record("http.runtime", await http("GET", `/v1/connectors/${NOTION}/runtime`));
    record("http.runtime.mcp", await http("GET", `/v1/connectors/${REMOTE}/runtime`));
    record("http.runtime.missing", await http("GET", `/v1/connectors/${MISSING}/runtime`));
    record("http.runtime.invalid", await http("GET", "/v1/connectors/nope/runtime"));
    record(
      "http.runtime.denied",
      await http("GET", `/v1/connectors/${NOTION}/runtime`, undefined, deniedKey),
    );
  });

  test("tool confirmation", async () => {
    const path = `/v1/connectors/${REMOTE}/mcp/tool-confirmation`;
    record("http.confirm.off", await http("PUT", path, { tool: "search_items", confirm: false }));
    record("http.confirm.on", await http("PUT", path, { tool: "search_items", confirm: true }));
    record("http.confirm.extra", await http("PUT", path, { tool: "x", confirm: true, more: 1 }));
    record("http.confirm.empty", await http("PUT", path, { tool: "", confirm: true }));
    record(
      "http.confirm.not-mcp",
      await http("PUT", `/v1/connectors/${NOTION}/mcp/tool-confirmation`, {
        tool: "x",
        confirm: false,
      }),
    );
    record(
      "http.confirm.missing",
      await http("PUT", `/v1/connectors/${MISSING}/mcp/tool-confirmation`, {
        tool: "x",
        confirm: false,
      }),
    );
    record(
      "http.confirm.denied",
      await http("PUT", path, { tool: "search_items", confirm: false }, deniedKey),
    );
    record("http.confirm.audit", await auditFor([REMOTE]));
  });
});

describe("connector tools keep their results byte for byte", () => {
  test("descriptors", () => {
    record("tool.descriptor.list", descriptor(listConnectorsTool));
    record("tool.descriptor.get", descriptor(getConnectorTool));
  });

  test("list_connectors", async () => {
    record("tool.list", await listConnectorsTool.execute(toolCtx(), {}));
    record(
      "tool.list.category",
      await listConnectorsTool.execute(toolCtx(), { category: "notion" }),
    );
    record("tool.list.driver", await listConnectorsTool.execute(toolCtx(), { driver: "graphql" }));
    record("tool.list.none", await listConnectorsTool.execute(toolCtx(), { driver: "s3" }));
  });

  test("get_connector", async () => {
    record("tool.get", await getConnectorTool.execute(toolCtx(), { id: NOTION }));
    record("tool.get.prod", await getConnectorTool.execute(toolCtx(), { id: GRAPH }));
    record("tool.get.reauth", await getConnectorTool.execute(toolCtx(), { id: REAUTH }));
    record("tool.get.missing", await getConnectorTool.execute(toolCtx(), { id: MISSING }));
  });

  test("the golden file has no stale entries", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });
});
