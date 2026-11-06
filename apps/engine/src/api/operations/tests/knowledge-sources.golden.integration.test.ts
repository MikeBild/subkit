import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { and, asc, eq } from "drizzle-orm";
import {
  getKnowledgeSourceTool,
  listKnowledgeSourcesTool,
} from "../../../conversations/tools/engine-api/knowledge-sources.ts";
import type { ToolContext } from "../../../conversations/tools/index.ts";
import { auditLog, users } from "../../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../http/tests/setup.ts";
import { createKnowledgeSource } from "../../../knowledge/service.ts";
import * as invokeModule from "../../../llm/core/invoke.ts";
import { createDeterministicHexFactory } from "../../../test-helpers/determinism/ids.ts";
import { emptyRoleId } from "../../../test-helpers/roles.ts";
import { makeToolCtx } from "../../../test-helpers/seed.ts";

const GOLDEN_PATH = new URL("./fixtures/knowledge-sources.golden.json", import.meta.url).pathname;
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, string>;
const actual: Record<string, string> = {};

let ctx: HttpTestServer;
let deniedKey: string;
let runbookId: string;
let policyId: string;
let doomedId: string;
let page: Server;
let pageOrigin = "";
const MISSING = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";

function normalize(value: unknown): string {
  let text = JSON.stringify(value).replaceAll(ctx.tenantId, "<tenant>");
  for (const [id, label] of [
    [runbookId, "<runbook>"],
    [policyId, "<policy>"],
    [doomedId, "<doomed>"],
  ] as const) {
    text = text.replaceAll(id, label);
  }
  return text
    .replace(/127\.0\.0\.1:\d+/g, "<page>")
    .replace(/127-0-0-1-\d+/g, "<page-slug>")
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

async function seedSource(
  slug: string,
  input: { description?: string; category?: string; tags?: string[] },
  content: string,
): Promise<string> {
  const source = await createKnowledgeSource(
    {
      tenant_id: ctx.tenantId,
      input: { name: slug, slug, scope: "global", ...input },
      upload: {
        buffer: Buffer.from(content, "utf8"),
        filename: `${slug}.md`,
        mime: "text/markdown",
      },
      actor: null,
      source_type_override: "inline",
      source_uri_override: `${slug}.md`,
    },
    ctx.db,
  );
  return source.id;
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

beforeAll(async () => {
  ctx = await createHttpTestServer("operations_knowledge_sources_golden");
  page = createServer((req, res) => {
    if (req.url === "/missing") {
      res.writeHead(404).end("gone");
      return;
    }
    if (req.url === "/image") {
      res.writeHead(200, { "content-type": "image/png" }).end("png");
      return;
    }
    res
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end("<html><body><h1>Returns</h1><p>Within 30 days.</p></body></html>");
  });
  await new Promise<void>((resolve) => page.listen(0, "127.0.0.1", resolve));
  const address = page.address();
  if (address === null || typeof address === "string") throw new Error("no page server port");
  pageOrigin = `http://127.0.0.1:${address.port}`;
  runbookId = await seedSource(
    "deploy-runbook",
    { description: "How to deploy the engine.", category: "devops", tags: ["deploy"] },
    "# Deploy\n\nRun the release pipeline, then verify the health endpoint.",
  );
  policyId = await seedSource(
    "access-policy",
    { category: "security" },
    "# Access\n\nAll API access requires bearer tokens.\n\n## Logging\n\nAudit logs stay 90 days.",
  );
  doomedId = await seedSource("old-notes", {}, "# Old notes\n\nNothing important.");
  const [denied] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "denied-knowledge@test.local",
      role_id: await emptyRoleId(ctx.db, ctx.tenantId),
    })
    .returning();
  if (!denied) throw new Error("denied user insert returned no row");
  const rand = createDeterministicHexFactory(0x6b_5c)(16);
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
  page.closeAllConnections?.();
  await new Promise<void>((resolve) => page.close(() => resolve()));
  await ctx.cleanup();
});

describe("knowledge source operations keep their HTTP responses byte for byte", () => {
  test("list", async () => {
    record("http.list", await http("GET", "/v1/knowledge-sources?sort=name"));
    record("http.list.page", await http("GET", "/v1/knowledge-sources?sort=name&limit=1&offset=1"));
    record("http.list.category", await http("GET", "/v1/knowledge-sources?category=devops"));
    record("http.list.search", await http("GET", "/v1/knowledge-sources?q=policy"));
    record("http.list.invalid", await http("GET", "/v1/knowledge-sources?limit=0"));
  });

  test("get", async () => {
    record("http.get", await http("GET", `/v1/knowledge-sources/${runbookId}`));
    record("http.get.missing", await http("GET", `/v1/knowledge-sources/${MISSING}`));
    record("http.get.invalid", await http("GET", "/v1/knowledge-sources/not-a-uuid"));
  });

  test("permission is checked before the body is validated", async () => {
    record("http.denied.list", await http("GET", "/v1/knowledge-sources", undefined, deniedKey));
    record(
      "http.denied.get",
      await http("GET", `/v1/knowledge-sources/${runbookId}`, undefined, deniedKey),
    );
    record(
      "http.denied.update",
      await http("PATCH", `/v1/knowledge-sources/${runbookId}`, { name: "" }, deniedKey),
    );
    record(
      "http.denied.analyze",
      await http("POST", `/v1/knowledge-sources/${runbookId}/analyze`, { force: 1 }, deniedKey),
    );
    record(
      "http.denied.delete",
      await http("DELETE", `/v1/knowledge-sources/${doomedId}`, undefined, deniedKey),
    );
  });

  test("update", async () => {
    record(
      "http.update",
      await http("PATCH", `/v1/knowledge-sources/${runbookId}`, {
        name: "Deploy runbook",
        tags: ["deploy", "release", "deploy"],
        category: "ops",
      }),
    );
    record(
      "http.update.address-read-only",
      await http("PATCH", `/v1/knowledge-sources/${runbookId}`, {
        source_uri: "https://example.com/runbook",
      }),
    );
    record(
      "http.update.scope-without-workflow",
      await http("PATCH", `/v1/knowledge-sources/${runbookId}`, { scope: "workflow" }),
    );
    record(
      "http.update.accept-mismatch",
      await http("PATCH", `/v1/knowledge-sources/${runbookId}`, { accept_description: true }),
    );
    record(
      "http.update.invalid",
      await http("PATCH", `/v1/knowledge-sources/${runbookId}`, { name: "" }),
    );
    record(
      "http.update.missing",
      await http("PATCH", `/v1/knowledge-sources/${MISSING}`, { name: "Nobody" }),
    );
    record(
      "http.update.invalid-id",
      await http("PATCH", "/v1/knowledge-sources/not-a-uuid", { name: "Nobody" }),
    );
  });

  test("analyze", async () => {
    const spy = spyOn(invokeModule, "invoke").mockResolvedValue(
      invokeResult({
        description: "Access and logging policy.",
        category: "security",
        tags: ["security", "logging"],
      }) as never,
    );
    try {
      record("http.analyze", await http("POST", `/v1/knowledge-sources/${policyId}/analyze`, {}));
      record(
        "http.analyze.force",
        await http("POST", `/v1/knowledge-sources/${policyId}/analyze`, { force: true }),
      );
      record(
        "http.analyze.missing",
        await http("POST", `/v1/knowledge-sources/${MISSING}/analyze`, {}),
      );
      record(
        "http.analyze.invalid",
        await http("POST", `/v1/knowledge-sources/${policyId}/analyze`, { force: "yes" }),
      );
    } finally {
      spy.mockRestore();
    }
  });

  test("delete", async () => {
    record("http.delete", await http("DELETE", `/v1/knowledge-sources/${doomedId}`));
    record("http.delete.again", await http("DELETE", `/v1/knowledge-sources/${doomedId}`));
    record("http.delete.missing", await http("DELETE", `/v1/knowledge-sources/${MISSING}`));
    record("http.delete.get", await http("GET", `/v1/knowledge-sources/${doomedId}`));
  });

  test("audit trail", async () => {
    const trail = await ctx.db
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
      .where(and(eq(auditLog.tenant_id, ctx.tenantId)))
      .orderBy(asc(auditLog.ts), asc(auditLog.action));
    record(
      "http.audit",
      trail.filter(
        (row) =>
          row.resource_type === "knowledge_source" ||
          row.action === "policy.denied" ||
          row.resource_type === "policy",
      ),
    );
  });
});

describe("knowledge source tools keep their results byte for byte", () => {
  test("list_knowledge_sources", async () => {
    record("tool.list", await listKnowledgeSourcesTool.execute(toolCtx(), {}));
    record(
      "tool.list.category",
      await listKnowledgeSourcesTool.execute(toolCtx(), { category: "security" }),
    );
    record(
      "tool.list.empty",
      await listKnowledgeSourcesTool.execute(toolCtx(), { category: "nothing" }),
    );
  });

  test("get_knowledge_source", async () => {
    record("tool.get", await getKnowledgeSourceTool.execute(toolCtx(), { id: policyId }));
    record("tool.get.missing", await getKnowledgeSourceTool.execute(toolCtx(), { id: MISSING }));
  });
});

describe("address knowledge sources keep their HTTP responses byte for byte", () => {
  test("create from an address", async () => {
    record(
      "http.url.denied",
      await http("POST", "/v1/knowledge-sources/url", { url: "nope" }, deniedKey),
    );
    const created = await http("POST", "/v1/knowledge-sources/url", {
      url: `${pageOrigin}/returns`,
      category: "support",
    });
    record("http.url", created);
    record(
      "http.url.unreadable",
      await http("POST", "/v1/knowledge-sources/url", { url: `${pageOrigin}/missing` }),
    );
    record(
      "http.url.unsupported",
      await http("POST", "/v1/knowledge-sources/url", { url: `${pageOrigin}/image` }),
    );
    record("http.url.invalid", await http("POST", "/v1/knowledge-sources/url", { url: "nope" }));
    const createdId = (created.body as { id: string }).id;
    record(
      "http.refresh.denied",
      await http("POST", `/v1/knowledge-sources/${createdId}/refresh`, undefined, deniedKey),
    );
    record("http.refresh", await http("POST", `/v1/knowledge-sources/${createdId}/refresh`));
    record(
      "http.refresh.not-an-address",
      await http("POST", `/v1/knowledge-sources/${runbookId}/refresh`),
    );
    record("http.refresh.missing", await http("POST", `/v1/knowledge-sources/${MISSING}/refresh`));
    record("http.refresh.invalid", await http("POST", "/v1/knowledge-sources/not-a-uuid/refresh"));
    const trail = await ctx.db
      .select({
        action: auditLog.action,
        actor_type: auditLog.actor_type,
        result: auditLog.result,
        reason: auditLog.reason,
        metadata: auditLog.metadata,
      })
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.resource_id, createdId)))
      .orderBy(asc(auditLog.ts), asc(auditLog.action));
    record("http.url.audit", trail);
  });

  test("the golden file has no stale entries", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });
});
