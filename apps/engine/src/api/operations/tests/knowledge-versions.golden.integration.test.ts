import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, like } from "drizzle-orm";
import { auditLog, users } from "../../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../http/tests/setup.ts";
import { createKnowledgeSource } from "../../../knowledge/service.ts";
import { createDeterministicHexFactory } from "../../../test-helpers/determinism/ids.ts";
import { emptyRoleId } from "../../../test-helpers/roles.ts";
import { seedTenant } from "../../../test-helpers/seed.ts";

const GOLDEN_PATH = new URL("./fixtures/knowledge-versions.golden.json", import.meta.url).pathname;
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, string>;
const actual: Record<string, string> = {};
const uuidNames = new Map<string, string>();
const MISSING = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";

let ctx: HttpTestServer;
let deniedKey: string;
let sourceId: string;
let foreignId: string;

function uuidName(uuid: string): string {
  const known = uuidNames.get(uuid);
  if (known) return known;
  const name = `<uuid:${uuidNames.size + 1}>`;
  uuidNames.set(uuid, name);
  return name;
}

function normalize(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll(ctx.tenantId, "<tenant>")
    .replaceAll(ctx.userId, "<admin>")
    .replace(/"20(2[4-9]|[3-9]\d)-\d\d-\d\dT[\d:.]+Z"/g, '"<now>"')
    .replace(/"(trace_id|audit_trace_id|request_id)":"[^"]*"/g, '"$1":"<trace>"')
    .replace(
      /(?<![0-9a-f-])(?!0f0f0f0f)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f-])/g,
      (m) => uuidName(m),
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

async function auditTrail(): Promise<string[]> {
  const rows = await ctx.db
    .select({
      action: auditLog.action,
      actor_type: auditLog.actor_type,
      actor_id: auditLog.actor_id,
      resource_type: auditLog.resource_type,
      result: auditLog.result,
      reason: auditLog.reason,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, ctx.tenantId), like(auditLog.action, "knowledge%")));
  return rows.map((row) => normalize(row).replace(/<uuid:\d+>/g, "<id>")).sort();
}

async function deniedTrail(): Promise<string[]> {
  const rows = await ctx.db
    .select({ action: auditLog.action, reason: auditLog.reason })
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.result, "denied")));
  return rows.map((row) => normalize(row)).sort();
}

beforeAll(async () => {
  ctx = await createHttpTestServer("operations_knowledge_versions_golden");
  const created = await http("POST", "/v1/knowledge-sources/inline", {
    name: "Escalation",
    content: "# Escalation\n\nCall the lead.",
  });
  if (created.status !== 201) throw new Error(`inline source returned ${created.status}`);
  sourceId = (created.body as { id: string }).id;
  for (const text of ["Call the lead after 15 minutes.", "Call the lead after 30 minutes."]) {
    const content = (await http("GET", `/v1/knowledge-sources/${sourceId}/content`)).body as {
      version: string;
      documents: { path: string }[];
    };
    const edited = await http("PUT", `/v1/knowledge-sources/${sourceId}/content`, {
      expected_version: content.version,
      path: content.documents[0]?.path,
      content: `# Escalation\n\n${text}`,
    });
    if (edited.status !== 200) throw new Error(`content edit returned ${edited.status}`);
  }
  const foreign = await seedTenant(ctx.db);
  foreignId = (
    await createKnowledgeSource(
      {
        tenant_id: foreign.id,
        input: { name: "foreign", slug: "foreign", scope: "global", tags: [] },
        upload: {
          buffer: Buffer.from("# Foreign", "utf8"),
          filename: "foreign.md",
          mime: "text/markdown",
        },
        actor: null,
        source_type_override: "inline",
        source_uri_override: "foreign.md",
      },
      ctx.db,
    )
  ).id;
  const [denied] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "denied-knowledge-versions@test.local",
      role_id: await emptyRoleId(ctx.db, ctx.tenantId),
    })
    .returning();
  if (!denied) throw new Error("denied user insert returned no row");
  deniedKey = `wf_live_${createDeterministicHexFactory(0x4b_76)(16)}`;
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
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
});

describe("knowledge source versions keep their HTTP responses byte for byte", () => {
  test("history", async () => {
    const base = `/v1/knowledge-sources/${sourceId}/history`;
    record("http.history", await http("GET", base));
    record("http.history.page", await http("GET", `${base}?limit=1&offset=1`));
    record("http.history.invalid", await http("GET", `${base}?limit=0`));
    record("http.history.missing", await http("GET", `/v1/knowledge-sources/${MISSING}/history`));
    record("http.history.foreign", await http("GET", `/v1/knowledge-sources/${foreignId}/history`));
    record("http.history.bad-id", await http("GET", "/v1/knowledge-sources/nope/history"));
  });

  test("one version", async () => {
    const base = `/v1/knowledge-sources/${sourceId}/history`;
    record("http.version", await http("GET", `${base}/1`));
    record("http.version.unknown", await http("GET", `${base}/9`));
    record("http.version.invalid", await http("GET", `${base}/0`));
    record(
      "http.version.foreign",
      await http("GET", `/v1/knowledge-sources/${foreignId}/history/1`),
    );
  });

  test("restore", async () => {
    const base = `/v1/knowledge-sources/${sourceId}/restore`;
    record("http.restore.current", await http("POST", `${base}/3`));
    record("http.restore.unknown", await http("POST", `${base}/9`));
    record("http.restore.invalid", await http("POST", `${base}/0`));
    record(
      "http.restore.foreign",
      await http("POST", `/v1/knowledge-sources/${foreignId}/restore/1`),
    );
    record("http.restore", await http("POST", `${base}/1`));
    record(
      "http.history.after-restore",
      await http("GET", `/v1/knowledge-sources/${sourceId}/history`),
    );
  });

  test("permission is checked before the input is validated", async () => {
    const calls: [string, string, string][] = [
      ["history", "GET", `/v1/knowledge-sources/${sourceId}/history?limit=0`],
      ["version", "GET", `/v1/knowledge-sources/${sourceId}/history/0`],
      ["restore", "POST", `/v1/knowledge-sources/${sourceId}/restore/0`],
      ["head.history", "HEAD", `/v1/knowledge-sources/${sourceId}/history`],
      ["head.version", "HEAD", `/v1/knowledge-sources/${sourceId}/history/1`],
      ["other-method.history", "POST", `/v1/knowledge-sources/${sourceId}/history`],
      ["other-method.version", "DELETE", `/v1/knowledge-sources/${sourceId}/history/1`],
      ["other-method.restore", "GET", `/v1/knowledge-sources/${sourceId}/restore/1`],
    ];
    for (const [name, method, path] of calls) {
      record(`http.denied.${name}`, await http(method, path, undefined, deniedKey));
    }
    record("http.denied.audit", await deniedTrail());
  });

  test("every change wrote its audit row", async () => {
    record("http.audit", await auditTrail());
  });

  test("the golden file has no stale entries", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });
});
