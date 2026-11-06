import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "@hono/zod-openapi";
import { and, asc, eq } from "drizzle-orm";
import {
  getKnowledgeSourceTool,
  listKnowledgeSourcesTool,
} from "../../../conversations/tools/engine-api/knowledge-sources.ts";
import { analyzeKnowledgeSourceTool } from "../../../conversations/tools/engine-api/writes/analyze-knowledge-source.ts";
import { updateKnowledgeSourceTool } from "../../../conversations/tools/engine-api/writes/update-knowledge-source.ts";
import type { ConversationTool, ToolContext } from "../../../conversations/tools/index.ts";
import { auditLog, users } from "../../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../http/tests/setup.ts";
import { createKnowledgeSource } from "../../../knowledge/service.ts";
import * as invokeModule from "../../../llm/core/invoke.ts";
import { createDeterministicHexFactory } from "../../../test-helpers/determinism/ids.ts";
import { adminPrincipal } from "../../../test-helpers/principals.ts";
import { emptyRoleId } from "../../../test-helpers/roles.ts";
import { makeToolCtx } from "../../../test-helpers/seed.ts";

const GOLDEN_PATH = new URL("./fixtures/knowledge-content.golden.json", import.meta.url).pathname;
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, string>;
const actual: Record<string, string> = {};
const uuidNames = new Map<string, string>();

let ctx: HttpTestServer;
let deniedKey: string;
let runbookId: string;
let plainId: string;
const MISSING = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";

function normalize(value: unknown): string {
  let text = JSON.stringify(value).replaceAll(ctx.tenantId, "<tenant>");
  for (const [id, label] of [
    [runbookId, "<runbook>"],
    [plainId, "<plain>"],
  ] as const) {
    text = text.replaceAll(id, label);
  }
  return text
    .replace(/"20(2[4-9]|[3-9]\d)-\d\d-\d\dT[\d:.]+Z"/g, '"<now>"')
    .replace(/"20(2[4-9]|[3-9]\d)-\d\d-\d\d [\d:.]+\+00"/g, '"<now>"')
    .replace(/,20(2[4-9]|[3-9]\d)-\d\d-\d\dT[\d:.]+Z,/g, ",<now>,")
    .replace(/"trace_id":"[^"]*"/g, '"trace_id":"<trace>"')
    .replace(/"request_id":"[^"]*"/g, '"request_id":"<request>"')
    .replace(/"audit_trace_id":"[^"]*"/g, '"audit_trace_id":"<trace>"')
    .replace(
      /\b(?!5eed|0f0f0f0f)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g,
      (uuid) => {
        const known = uuidNames.get(uuid);
        if (known) return known;
        const name = `<uuid-${uuidNames.size + 1}>`;
        uuidNames.set(uuid, name);
        return name;
      },
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

async function seedSource(
  slug: string,
  content: string,
  mime: string,
  filename: string,
  tags: string[],
): Promise<string> {
  const source = await createKnowledgeSource(
    {
      tenant_id: ctx.tenantId,
      input: { name: slug, slug, scope: "global", description: `About ${slug}.`, tags },
      upload: { buffer: Buffer.from(content, "utf8"), filename, mime },
      actor: null,
      source_type_override: "inline",
      source_uri_override: filename,
    },
    ctx.db,
  );
  return source.id;
}

function descriptor(tool: ConversationTool) {
  return {
    name: tool.name,
    description: tool.description,
    category: tool.category,
    permission: tool.permission,
    strict: tool.strict,
    use_case: tool.use_case,
    important_notes: tool.important_notes,
    input: z.toJSONSchema(tool.inputSchema as z.ZodTypeAny),
  };
}

function invokeResult(object: unknown) {
  return {
    object,
    text: JSON.stringify(object),
    model_used: "test-model",
    fell_back: false,
    route: {} as never,
    assembled: {} as never,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
  };
}

function systemCtx(): ToolContext {
  return makeToolCtx({ db: ctx.db, tenant_id: ctx.tenantId });
}

function principalCtx(): ToolContext {
  return makeToolCtx({
    db: ctx.db,
    tenant_id: ctx.tenantId,
    actor_id: ctx.userId,
    principal: adminPrincipal(ctx.tenantId, ctx.userId),
  });
}

function actorCtx(): ToolContext {
  return makeToolCtx({ db: ctx.db, tenant_id: ctx.tenantId, actor_id: ctx.userId });
}

async function auditTrail() {
  const rows = await ctx.db
    .select({
      action: auditLog.action,
      actor_type: auditLog.actor_type,
      actor_id: auditLog.actor_id,
      resource_type: auditLog.resource_type,
      resource_id: auditLog.resource_id,
      result: auditLog.result,
      reason: auditLog.reason,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, ctx.tenantId)))
    .orderBy(asc(auditLog.ts), asc(auditLog.action));
  const key = (row: (typeof rows)[number]) =>
    JSON.stringify(row)
      .replace(/"(audit_)?trace_id":"[^"]*"/g, "")
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "");
  return rows
    .filter(
      (row) =>
        row.resource_type === "knowledge_source" ||
        row.action === "policy.denied" ||
        row.resource_type === "policy",
    )
    .toSorted((a, b) => key(a).localeCompare(key(b)));
}

beforeAll(async () => {
  ctx = await createHttpTestServer("operations_knowledge_content_golden");
  runbookId = await seedSource(
    "deploy-runbook",
    "# Deploy\n\nRun the release pipeline.\n\n## Verify\n\nCheck the health endpoint after deploy.",
    "text/markdown",
    "deploy-runbook.md",
    ["deploy"],
  );
  plainId = await seedSource(
    "plain-notes",
    "Plain deploy notes without markdown.",
    "text/plain",
    "plain-notes.txt",
    ["notes"],
  );
  const [denied] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "denied-knowledge-content@test.local",
      role_id: await emptyRoleId(ctx.db, ctx.tenantId),
    })
    .returning();
  if (!denied) throw new Error("denied user insert returned no row");
  const rand = createDeterministicHexFactory(0x6b_5d)(16);
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

describe("knowledge content operations keep their HTTP responses byte for byte", () => {
  test("permission is checked before the request is validated", async () => {
    record(
      "http.denied.inline",
      await http("POST", "/v1/knowledge-sources/inline", { name: "" }, deniedKey),
    );
    record(
      "http.denied.bundle",
      await http("POST", "/v1/knowledge-sources/bundle", { files: [] }, deniedKey),
    );
    record(
      "http.denied.search",
      await http("GET", "/v1/knowledge-sources/search?q=deploy", undefined, deniedKey),
    );
    record(
      "http.denied.chunks",
      await http("GET", `/v1/knowledge-sources/${runbookId}/chunks`, undefined, deniedKey),
    );
    record(
      "http.denied.content",
      await http("GET", `/v1/knowledge-sources/${runbookId}/content`, undefined, deniedKey),
    );
    record(
      "http.denied.content.put",
      await http("PUT", `/v1/knowledge-sources/${runbookId}/content`, { path: "" }, deniedKey),
    );
  });

  test("search", async () => {
    record("http.search", await http("GET", "/v1/knowledge-sources/search?q=deploy"));
    record(
      "http.search.tags",
      await http("GET", "/v1/knowledge-sources/search?q=deploy&tags=notes,%20,other&limit=5"),
    );
    record(
      "http.search.scope",
      await http("GET", "/v1/knowledge-sources/search?q=deploy&scope=workflow"),
    );
    record("http.search.invalid", await http("GET", "/v1/knowledge-sources/search?q="));
    record(
      "http.search.limit",
      await http("GET", "/v1/knowledge-sources/search?q=deploy&limit=99"),
    );
  });

  test("chunks", async () => {
    record("http.chunks", await http("GET", `/v1/knowledge-sources/${runbookId}/chunks`));
    record(
      "http.chunks.page",
      await http("GET", `/v1/knowledge-sources/${runbookId}/chunks?limit=1&offset=1`),
    );
    record(
      "http.chunks.path",
      await http("GET", `/v1/knowledge-sources/${runbookId}/chunks?path=/nowhere.md`),
    );
    record("http.chunks.missing", await http("GET", `/v1/knowledge-sources/${MISSING}/chunks`));
    record("http.chunks.invalid", await http("GET", "/v1/knowledge-sources/not-a-uuid/chunks"));
    record(
      "http.chunks.invalid-limit",
      await http("GET", `/v1/knowledge-sources/${runbookId}/chunks?limit=0`),
    );
  });

  test("content", async () => {
    const current = await http("GET", `/v1/knowledge-sources/${runbookId}/content`);
    record("http.content", current);
    record("http.content.plain", await http("GET", `/v1/knowledge-sources/${plainId}/content`));
    record("http.content.missing", await http("GET", `/v1/knowledge-sources/${MISSING}/content`));
    record("http.content.invalid", await http("GET", "/v1/knowledge-sources/not-a-uuid/content"));
    const version = (current.body as { version: string }).version;
    const documentPath = (current.body as { documents: { path: string }[] }).documents[0]?.path;
    record(
      "http.content.put",
      await http("PUT", `/v1/knowledge-sources/${runbookId}/content`, {
        expected_version: version,
        path: documentPath,
        content: "# Deploy\n\nRun the release pipeline twice.",
        note: "clarify",
      }),
    );
    record(
      "http.content.put.conflict",
      await http("PUT", `/v1/knowledge-sources/${runbookId}/content`, {
        expected_version: version,
        path: documentPath,
        content: "# Deploy\n\nStale edit.",
      }),
    );
    const plain = await http("GET", `/v1/knowledge-sources/${plainId}/content`);
    record(
      "http.content.put.read-only",
      await http("PUT", `/v1/knowledge-sources/${plainId}/content`, {
        expected_version: (plain.body as { version: string }).version,
        path: "plain-notes.txt",
        content: "changed",
      }),
    );
    record(
      "http.content.put.missing",
      await http("PUT", `/v1/knowledge-sources/${MISSING}/content`, {
        expected_version: "x",
        path: "a.md",
        content: "x",
      }),
    );
    record(
      "http.content.put.invalid",
      await http("PUT", `/v1/knowledge-sources/${runbookId}/content`, { path: "" }),
    );
  });

  test("inline create", async () => {
    record(
      "http.inline",
      await http("POST", "/v1/knowledge-sources/inline", {
        name: "Returns policy",
        content: "# Returns\n\nWithin 30 days.",
        tags: ["support"],
        description: "How returns work.",
      }),
    );
    record(
      "http.inline.source-uri",
      await http("POST", "/v1/knowledge-sources/inline", {
        name: "Shipping",
        slug: "shipping",
        content: '{"carrier":"dhl"}',
        mime_type: "application/json",
        source_uri: "https://example.com/shipping.json",
      }),
    );
    record(
      "http.inline.slug-taken",
      await http("POST", "/v1/knowledge-sources/inline", {
        name: "Shipping again",
        slug: "shipping",
        content: "# Shipping",
      }),
    );
    record(
      "http.inline.invalid",
      await http("POST", "/v1/knowledge-sources/inline", { name: "", content: "" }),
    );
    record(
      "http.inline.invalid-uri",
      await http("POST", "/v1/knowledge-sources/inline", {
        name: "x",
        content: "x",
        source_uri: "nope",
      }),
    );
  });

  test("bundle import", async () => {
    const files = [
      { path: "runbooks/deploy.md", content: "# Deploy\n\nShip it." },
      { path: "runbooks/rollback.md", content: "# Rollback\n\nRevert it." },
    ];
    record(
      "http.bundle",
      await http("POST", "/v1/knowledge-sources/bundle", { name: "Ops bundle", files }),
    );
    record(
      "http.bundle.unchanged",
      await http("POST", "/v1/knowledge-sources/bundle", { name: "Ops bundle", files }),
    );
    record(
      "http.bundle.updated",
      await http("POST", "/v1/knowledge-sources/bundle", {
        name: "Ops bundle",
        files: [...files, { path: "notes.txt", content: "skip me" }],
      }),
    );
    record(
      "http.bundle.create-only",
      await http("POST", "/v1/knowledge-sources/bundle", {
        name: "Ops bundle",
        files,
        create_only: true,
      }),
    );
    record(
      "http.bundle.slug-conflict",
      await http("POST", "/v1/knowledge-sources/bundle", {
        name: "Deploy runbook",
        slug: "deploy-runbook",
        files,
      }),
    );
    record(
      "http.bundle.invalid",
      await http("POST", "/v1/knowledge-sources/bundle", { name: "x", files: [] }),
    );
    record(
      "http.bundle.workflow-scope",
      await http("POST", "/v1/knowledge-sources/bundle", {
        name: "x",
        scope: "workflow",
        files,
      }),
    );
  });

  test("audit trail", async () => {
    record("http.audit", await auditTrail());
  });
});

describe("knowledge tools keep their descriptors and results", () => {
  test("descriptors", () => {
    record("tool.descriptor.list", descriptor(listKnowledgeSourcesTool));
    record("tool.descriptor.get", descriptor(getKnowledgeSourceTool));
    record("tool.descriptor.update", descriptor(updateKnowledgeSourceTool));
    record("tool.descriptor.analyze", descriptor(analyzeKnowledgeSourceTool));
  });

  test("update_knowledge_source", async () => {
    record(
      "tool.update.system",
      await updateKnowledgeSourceTool.execute(systemCtx(), {
        id: runbookId,
        name: "Deploy runbook",
        tags: ["deploy", "release"],
      }),
    );
    record(
      "tool.update.principal",
      await updateKnowledgeSourceTool.execute(principalCtx(), {
        id: runbookId,
        description: "How the engine ships.",
        status: "active",
      }),
    );
    record(
      "tool.update.actor",
      await updateKnowledgeSourceTool.execute(actorCtx(), {
        id: plainId,
        refresh_strategy: "manual",
        refresh_cron: null,
      }),
    );
    record(
      "tool.update.missing",
      await updateKnowledgeSourceTool.execute(systemCtx(), { id: MISSING, name: "Nobody" }),
    );
    record(
      "tool.update.scope-without-workflow",
      await updateKnowledgeSourceTool.execute(systemCtx(), { id: plainId, scope: "workflow" }),
    );
    const unknownWorkflow = await updateKnowledgeSourceTool.execute(systemCtx(), {
      id: plainId,
      scope: "workflow",
      workflow_id: MISSING,
    });
    record("tool.update.unknown-workflow", {
      ok: unknownWorkflow.ok,
      error: (unknownWorkflow.data as { error: string }).error,
    });
  });

  test("analyze_knowledge_source", async () => {
    const spy = spyOn(invokeModule, "invoke").mockResolvedValue(
      invokeResult({
        description: "Plain deploy notes.",
        category: "devops",
        tags: ["deploy", "notes"],
      }) as never,
    );
    try {
      record(
        "tool.analyze.system",
        await analyzeKnowledgeSourceTool.execute(systemCtx(), { id: plainId }),
      );
      record(
        "tool.analyze.principal",
        await analyzeKnowledgeSourceTool.execute(principalCtx(), { id: plainId, force: true }),
      );
      record(
        "tool.analyze.actor",
        await analyzeKnowledgeSourceTool.execute(actorCtx(), { id: runbookId, force: false }),
      );
      record(
        "tool.analyze.missing",
        await analyzeKnowledgeSourceTool.execute(systemCtx(), { id: MISSING }),
      );
      spy.mockRejectedValue(new Error("model unavailable"));
      record(
        "tool.analyze.failed",
        await analyzeKnowledgeSourceTool.execute(systemCtx(), { id: runbookId, force: true }),
      );
    } finally {
      spy.mockRestore();
    }
  });

  test("tool audit trail", async () => {
    record("tool.audit", await auditTrail());
  });

  test("the golden file has no stale entries", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });
});
