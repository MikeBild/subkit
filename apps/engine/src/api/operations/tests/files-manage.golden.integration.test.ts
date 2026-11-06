import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, like } from "drizzle-orm";
import { MAX_INLINE_BYTES } from "../../../api/files-schemas.ts";
import { auditLog, users } from "../../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../http/tests/setup.ts";
import { createDeterministicHexFactory } from "../../../test-helpers/determinism/ids.ts";
import { emptyRoleId } from "../../../test-helpers/roles.ts";

const GOLDEN_PATH = new URL("./fixtures/files-manage.golden.json", import.meta.url).pathname;
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, string>;
const actual: Record<string, string> = {};
const uuidNames = new Map<string, string>();
const MISSING = "fid_0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";

let ctx: HttpTestServer;
let deniedKey: string;
let alphaId: string;
let betaId: string;

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

function content(text: string, filename = "beta.txt") {
  return {
    filename,
    content_type: "text/plain",
    content_base64: Buffer.from(text).toString("base64"),
  };
}

async function inline(text: string, filename: string): Promise<string> {
  const res = await http("POST", "/v1/files/inline", content(text, filename));
  if (res.status !== 201) throw new Error(`inline upload returned ${res.status}`);
  return (res.body as { id: string }).id;
}

async function auditTrail(): Promise<string[]> {
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
    .where(and(eq(auditLog.tenant_id, ctx.tenantId), like(auditLog.action, "file.%")));
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
  ctx = await createHttpTestServer("operations_files_manage_golden");
  alphaId = await inline("alpha content", "alpha.txt");
  betaId = await inline("beta content", "beta.txt");
  const [denied] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "denied-files-manage@test.local",
      role_id: await emptyRoleId(ctx.db, ctx.tenantId),
    })
    .returning();
  if (!denied) throw new Error("denied user insert returned no row");
  deniedKey = `wf_live_${createDeterministicHexFactory(0xf1_3a)(16)}`;
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

describe("file replace and restore keep their HTTP responses byte for byte", () => {
  test("replace", async () => {
    record("http.replace", await http("POST", `/v1/files/${betaId}/replace`, content("beta two")));
    record(
      "http.replace.duplicate",
      await http("POST", `/v1/files/${betaId}/replace`, content("alpha content")),
    );
    record(
      "http.replace.empty",
      await http("POST", `/v1/files/${betaId}/replace`, { ...content("x"), content_base64: "=" }),
    );
    record(
      "http.replace.too_large",
      await http("POST", `/v1/files/${betaId}/replace`, content("y".repeat(MAX_INLINE_BYTES + 1))),
    );
    record(
      "http.replace.missing",
      await http("POST", `/v1/files/${MISSING}/replace`, content("z")),
    );
    record("http.replace.invalid-id", await http("POST", "/v1/files/nope/replace", content("z")));
    record("http.replace.invalid", await http("POST", `/v1/files/${betaId}/replace`, {}));
  });

  test("versions content stays a download route", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/files/${betaId}/versions/1/content`, {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    record("http.version-content", {
      status: res.status,
      content_type: res.headers.get("content-type"),
      text: await res.text(),
    });
  });

  test("restore", async () => {
    record("http.restore.current", await http("POST", `/v1/files/${betaId}/versions/2/restore`));
    record("http.restore.unknown", await http("POST", `/v1/files/${betaId}/versions/9/restore`));
    record("http.restore.missing", await http("POST", `/v1/files/${MISSING}/versions/1/restore`));
    record("http.restore.invalid", await http("POST", `/v1/files/${betaId}/versions/0/restore`));
    record("http.restore", await http("POST", `/v1/files/${betaId}/versions/1/restore`));
    record("http.restore.again", await http("POST", `/v1/files/${betaId}/versions/1/restore`));
    await http("POST", `/v1/files/${alphaId}/replace`, content("beta two", "alpha.txt"));
    record("http.restore.duplicate", await http("POST", `/v1/files/${betaId}/versions/2/restore`));
  });

  test("permission is checked before the body is validated", async () => {
    const calls: [string, string, string, unknown?][] = [
      ["replace", "POST", `/v1/files/${betaId}/replace`, {}],
      ["restore", "POST", `/v1/files/${betaId}/versions/1/restore`],
      ["other-method.replace", "GET", `/v1/files/${betaId}/replace`],
      ["other-method.restore", "DELETE", `/v1/files/${betaId}/versions/1/restore`],
      ["head.replace", "HEAD", `/v1/files/${betaId}/replace`],
    ];
    for (const [name, method, path, body] of calls) {
      record(`http.denied.${name}`, await http(method, path, body, deniedKey));
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
