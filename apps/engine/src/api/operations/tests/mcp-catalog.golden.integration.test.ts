import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { auditLog, users } from "../../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../http/tests/setup.ts";
import { createDeterministicHexFactory } from "../../../test-helpers/determinism/ids.ts";
import { emptyRoleId } from "../../../test-helpers/roles.ts";
import { seedConnector, seedTenant } from "../../../test-helpers/seed.ts";

const GOLDEN_PATH = new URL("./fixtures/mcp-catalog.golden.json", import.meta.url).pathname;
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, string>;
const actual: Record<string, string> = {};
const uuidNames = new Map<string, string>();

let ctx: HttpTestServer;
let deniedKey: string;

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
    .replace(/"(trace_id|audit_trace_id|request_id)":"[^"]*"/g, '"$1":"<trace>"')
    .replace(
      /(?<![0-9a-f-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f-])/g,
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
  key = ctx.apiKey,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}` },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  ctx = await createHttpTestServer("operations_mcp_catalog_golden");
  for (const title of ["Catalog Tone", "Catalog Format"]) {
    const res = await fetch(`${ctx.baseUrl}/v1/skills`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ scope: "global", title, body: `${title} body.` }),
    });
    if (res.status !== 201) throw new Error(`skill seed returned ${res.status}`);
  }
  await seedConnector(ctx.db, {
    tenant_id: ctx.tenantId,
    slug: "catalog-crm",
    display_name: "CRM",
  });
  await seedConnector(ctx.db, { tenant_id: ctx.tenantId, slug: "catalog-db", display_name: "DB" });
  const foreign = await seedTenant(ctx.db);
  await seedConnector(ctx.db, { tenant_id: foreign.id, slug: "foreign-crm", display_name: "X" });
  const [denied] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "denied-mcp-catalog@test.local",
      role_id: await emptyRoleId(ctx.db, ctx.tenantId),
    })
    .returning();
  if (!denied) throw new Error("denied user insert returned no row");
  deniedKey = `wf_live_${createDeterministicHexFactory(0x3c_a7)(16)}`;
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

describe("mcp catalog routes keep their HTTP responses byte for byte", () => {
  test("prompts and resources", async () => {
    record("http.prompts", await http("GET", "/v1/mcp/prompts"));
    record("http.resources", await http("GET", "/v1/mcp/resources"));
  });

  test("tools", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/mcp/tools`, {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    const text = await res.text();
    const body = JSON.parse(text) as { items: Record<string, unknown>[] };
    record("http.tools", {
      status: res.status,
      keys: [...new Set(body.items.flatMap((tool) => Object.keys(tool)))].sort(),
      names: body.items.map((tool) => tool.name),
    });
  });

  test("permission is checked on every method", async () => {
    for (const path of ["/v1/mcp/prompts", "/v1/mcp/resources", "/v1/mcp/tools"]) {
      for (const method of ["GET", "HEAD", "POST"]) {
        record(`http.denied.${method} ${path}`, await http(method, path, deniedKey));
      }
    }
    const rows = await ctx.db
      .select({ action: auditLog.action, reason: auditLog.reason })
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.result, "denied")));
    record("http.denied.audit", rows.map((row) => normalize(row)).sort());
  });

  test("the golden file has no stale entries", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });
});
