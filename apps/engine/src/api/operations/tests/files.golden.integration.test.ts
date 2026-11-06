import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, asc, eq } from "drizzle-orm";
import { auditLog, users } from "../../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../http/tests/setup.ts";
import { createDeterministicHexFactory } from "../../../test-helpers/determinism/ids.ts";
import { emptyRoleId } from "../../../test-helpers/roles.ts";
import { seedConversation } from "../../../test-helpers/seed.ts";

const GOLDEN_PATH = new URL("./fixtures/files.golden.json", import.meta.url).pathname;
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, string>;
const actual: Record<string, string> = {};
const uuidNames = new Map<string, string>();

let ctx: HttpTestServer;
let deniedKey: string;
let conversationId: string;
let alphaId: string;
let betaId: string;
let pendingId: string;
const MISSING = "fid_0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";

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
    .replace(/"20(2[4-9]|[3-9]\d)-\d\d-\d\dT[\d:.]+Z"/g, '"<now>"')
    .replace(/"trace_id":"[^"]*"/g, '"trace_id":"<trace>"')
    .replace(/"request_id":"[^"]*"/g, '"request_id":"<request>"')
    .replace(/"audit_trace_id":"[^"]*"/g, '"audit_trace_id":"<trace>"')
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

async function inline(text: string, filename: string): Promise<string> {
  const res = await http("POST", "/v1/files/inline", {
    filename,
    content_type: "text/plain",
    content_base64: Buffer.from(text).toString("base64"),
  });
  if (res.status !== 201) throw new Error(`inline upload returned ${res.status}`);
  return (res.body as { id: string }).id;
}

async function auditTrail(resource_id: string) {
  const rows = await ctx.db
    .select({
      action: auditLog.action,
      actor_type: auditLog.actor_type,
      resource_type: auditLog.resource_type,
      result: auditLog.result,
      reason: auditLog.reason,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.resource_id, resource_id)))
    .orderBy(asc(auditLog.ts), asc(auditLog.action));
  const key = (row: (typeof rows)[number]) =>
    `${row.action} ${JSON.stringify(row.metadata).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32}/g, "")}`;
  return rows.toSorted((a, b) => key(a).localeCompare(key(b)));
}

beforeAll(async () => {
  ctx = await createHttpTestServer("operations_files_golden");
  const conversation = await seedConversation(ctx.db, { tenant_id: ctx.tenantId });
  conversationId = conversation.id;
  alphaId = await inline("alpha content", "alpha.txt");
  betaId = await inline("beta content", "beta.txt");
  const replaced = await http("POST", `/v1/files/${betaId}/replace`, {
    filename: "beta.txt",
    content_type: "text/plain",
    content_base64: Buffer.from("beta content two").toString("base64"),
  });
  if (replaced.status !== 200) throw new Error(`replace returned ${replaced.status}`);
  const batch = await http("POST", "/v1/files/batch-create", {
    files: [
      {
        filename: "pending.txt",
        content_type: "text/plain",
        size_bytes: 7,
        sha256: createHash("sha256").update("pending").digest("hex"),
      },
    ],
  });
  if (batch.status !== 201) throw new Error(`batch-create returned ${batch.status}`);
  pendingId = (batch.body as { files: { id: string }[] }).files[0]?.id ?? "";
  const [denied] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "denied-files-operations@test.local",
      role_id: await emptyRoleId(ctx.db, ctx.tenantId),
    })
    .returning();
  if (!denied) throw new Error("denied user insert returned no row");
  deniedKey = `wf_live_${createDeterministicHexFactory(0xf1_1e)(16)}`;
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
}, 30_000);

describe("file operations keep their HTTP responses byte for byte", () => {
  test("list", async () => {
    record("http.list", await http("GET", "/v1/files"));
    record("http.list.page", await http("GET", "/v1/files?limit=1&sort=filename&order=asc"));
    record("http.list.status", await http("GET", "/v1/files?status=pending"));
    record("http.list.invalid", await http("GET", "/v1/files?limit=0"));
  });

  test("stats", async () => {
    record("http.stats", await http("GET", "/v1/files/stats"));
  });

  test("get", async () => {
    record("http.get", await http("GET", `/v1/files/${alphaId}`));
    record("http.get.missing", await http("GET", `/v1/files/${MISSING}`));
    record("http.get.invalid", await http("GET", "/v1/files/not-a-file-id"));
  });

  test("versions and usage", async () => {
    record("http.versions", await http("GET", `/v1/files/${betaId}/versions`));
    record("http.versions.missing", await http("GET", `/v1/files/${MISSING}/versions`));
    record("http.versions.invalid", await http("GET", "/v1/files/not-a-file-id/versions"));
    record("http.usage", await http("GET", `/v1/files/${alphaId}/usage`));
    record("http.usage.missing", await http("GET", `/v1/files/${MISSING}/usage`));
  });

  test("permission is checked before the body is validated", async () => {
    record("http.denied.list", await http("GET", "/v1/files", undefined, deniedKey));
    record("http.denied.stats", await http("GET", "/v1/files/stats", undefined, deniedKey));
    record("http.denied.get", await http("GET", `/v1/files/${alphaId}`, undefined, deniedKey));
    record(
      "http.denied.versions",
      await http("GET", `/v1/files/${alphaId}/versions`, undefined, deniedKey),
    );
    record(
      "http.denied.usage",
      await http("GET", `/v1/files/${alphaId}/usage`, undefined, deniedKey),
    );
    record(
      "http.denied.rename",
      await http("PATCH", `/v1/files/${alphaId}`, { filename: "" }, deniedKey),
    );
    record("http.denied.link", await http("POST", `/v1/files/${alphaId}/links`, {}, deniedKey));
    record(
      "http.denied.delete",
      await http("DELETE", `/v1/files/${alphaId}`, undefined, deniedKey),
    );
    for (const path of [
      "/v1/files",
      "/v1/files/stats",
      `/v1/files/${alphaId}`,
      `/v1/files/${alphaId}/versions`,
      `/v1/files/${alphaId}/usage`,
      `/v1/files/${alphaId}/links`,
    ]) {
      record(
        `http.denied.head ${path.replace(alphaId, "<id>")}`,
        await http("HEAD", path, undefined, deniedKey),
      );
    }
    record("http.denied.other-method.list", await http("POST", "/v1/files", {}, deniedKey));
    record(
      "http.denied.other-method.links",
      await http("GET", `/v1/files/${alphaId}/links`, undefined, deniedKey),
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
      .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.result, "denied")))
      .orderBy(asc(auditLog.ts), asc(auditLog.action));
    record("http.denied.audit", denials);
  });

  test("rename and category", async () => {
    record(
      "http.rename",
      await http("PATCH", `/v1/files/${alphaId}`, {
        filename: "alpha-renamed.txt",
        category: "golden",
        description: "Renamed by the golden test.",
      }),
    );
    record(
      "http.rename.noop",
      await http("PATCH", `/v1/files/${alphaId}`, { filename: "alpha-renamed.txt" }),
    );
    record(
      "http.rename.category-clear",
      await http("PATCH", `/v1/files/${alphaId}`, { category: null }),
    );
    record("http.rename.empty", await http("PATCH", `/v1/files/${alphaId}`, {}));
    record(
      "http.rename.accept-mismatch",
      await http("PATCH", `/v1/files/${alphaId}`, { accept_description: true }),
    );
    record(
      "http.rename.description-changed",
      await http("PATCH", `/v1/files/${alphaId}`, {
        description: "Not the stored description.",
        accept_description: true,
      }),
    );
    record(
      "http.rename.missing",
      await http("PATCH", `/v1/files/${MISSING}`, { filename: "nobody.txt" }),
    );
  });

  test("link", async () => {
    const target = { resource_type: "conversation", resource_id: conversationId };
    record(
      "http.link",
      await http("POST", `/v1/files/${alphaId}/links`, { ...target, slug: "spec" }),
    );
    record("http.link.pending", await http("POST", `/v1/files/${pendingId}/links`, target));
    record("http.link.missing", await http("POST", `/v1/files/${MISSING}/links`, target));
    record(
      "http.link.invalid",
      await http("POST", `/v1/files/${alphaId}/links`, { resource_type: "nope" }),
    );
    record("http.link.usage", await http("GET", `/v1/files/${alphaId}/usage`));
  });

  test("delete", async () => {
    record("http.delete", await http("DELETE", `/v1/files/${betaId}`));
    record("http.delete.again", await http("DELETE", `/v1/files/${betaId}`));
    record("http.delete.missing", await http("DELETE", `/v1/files/${MISSING}`));
    record("http.delete.get", await http("GET", `/v1/files/${betaId}`));
    record("http.delete.versions", await http("GET", `/v1/files/${betaId}/versions`));
    record("http.delete.stats", await http("GET", "/v1/files/stats"));
  });

  test("audit trail of the written files", async () => {
    record("http.audit.alpha", await auditTrail(alphaId.slice("fid_".length)));
    record("http.audit.beta", await auditTrail(betaId.slice("fid_".length)));
  });

  test("the golden file has no stale entries", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });
});
