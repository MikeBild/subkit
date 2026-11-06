import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, ne } from "drizzle-orm";
import { upsertCredential } from "../../../credentials/service.ts";
import { auditLog, users } from "../../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../http/tests/setup.ts";
import { createDeterministicHexFactory } from "../../../test-helpers/determinism/ids.ts";
import { emptyRoleId } from "../../../test-helpers/roles.ts";
import { seedConnector, seedTimestamp, seedUuid } from "../../../test-helpers/seed.ts";

const GOLDEN_PATH = new URL("./fixtures/connectors-promotion.golden.json", import.meta.url)
  .pathname;
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, string>;
const actual: Record<string, string> = {};
const uuidNames = new Map<string, string>();

let ctx: HttpTestServer;
let deniedKey: string;
const MISSING = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";
const COPY = seedUuid("connector", 201);
const MOVE = seedUuid("connector", 202);
const PROD = seedUuid("connector", 203);
const OAUTH = seedUuid("connector", 204);
const DENIED = seedUuid("connector", 205);
const BODY_COPY = { target_environment: "prod", strategy: "copy" };
const BODY_MOVE = { target_environment: "prod", strategy: "move" };

function uuidName(uuid: string): string {
  const known = uuidNames.get(uuid);
  if (known) return known;
  const name = `<uuid:${uuidNames.size + 1}>`;
  uuidNames.set(uuid, name);
  return name;
}

const UUID =
  /(?<![0-9a-f-])(?!5eed|0f0f0f0f)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f-])/g;

function normalize(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll(ctx.tenantId, "<tenant>")
    .replace(/"20(2[4-9]|[3-9]\d)-\d\d-\d\dT[\d:.]+Z"/g, '"<now>"')
    .replace(/"trace_id":"[^"]*"/g, '"trace_id":"<trace>"')
    .replace(/"request_id":"[^"]*"/g, '"request_id":"<request>"')
    .replace(/"audit_trace_id":"[^"]*"/g, '"audit_trace_id":"<trace>"')
    .replace(UUID, (m) => uuidName(m));
}

function record(name: string, value: unknown): void {
  actual[name] = normalize(value);
  expect(actual[name]).toBe(golden[name] as string);
}

async function promote(
  id: string,
  body: unknown,
  idempotencyKey: string | null,
  key = ctx.apiKey,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${ctx.baseUrl}/v1/connectors/${id}/promote`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      ...(idempotencyKey !== null ? { "idempotency-key": idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function auditTrail() {
  const rows = await ctx.db
    .select({
      action: auditLog.action,
      actor_type: auditLog.actor_type,
      resource_type: auditLog.resource_type,
      resource_id: auditLog.resource_id,
      result: auditLog.result,
      reason: auditLog.reason,
      before: auditLog.before,
      after: auditLog.after,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, ctx.tenantId), ne(auditLog.action, "api_key.used")));
  const key = (row: (typeof rows)[number]) =>
    JSON.stringify({ ...row, resource_id: null }).replace(UUID, "<uuid>");
  return rows.toSorted((a, b) => key(a).localeCompare(key(b)));
}

async function seedBearer(connector_id: string, token: string): Promise<void> {
  await upsertCredential(
    {
      tenant_id: ctx.tenantId,
      connector_id,
      environment: "dev",
      mode: "bearer",
      value: { mode: "bearer", token },
      actor_id: null,
      actor: null,
      source: "http_route",
    },
    ctx.db,
  );
}

beforeAll(async () => {
  ctx = await createHttpTestServer("operations_connectors_promotion_golden");
  const seeds = [
    { id: COPY, slug: "promote-copy", auth_type: "bearer", environment: "dev" },
    { id: MOVE, slug: "promote-move", auth_type: "bearer", environment: "dev" },
    { id: PROD, slug: "promote-prod", auth_type: "none", environment: "prod" },
    { id: OAUTH, slug: "promote-oauth", auth_type: "oauth2", environment: "dev" },
    { id: DENIED, slug: "promote-denied", auth_type: "none", environment: "dev" },
  ] as const;
  for (const [index, seed] of seeds.entries()) {
    await seedConnector(ctx.db, {
      tenant_id: ctx.tenantId,
      ...seed,
      display_name: seed.slug,
      base_url: `https://${seed.slug}.example.test`,
      created_at: seedTimestamp(201 + index),
      updated_at: seedTimestamp(201 + index),
    });
  }
  await seedBearer(COPY, "promote-copy-secret");
  await seedBearer(MOVE, "promote-move-secret");
  const [denied] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "denied-promotion@test.local",
      role_id: await emptyRoleId(ctx.db, ctx.tenantId),
    })
    .returning();
  if (!denied) throw new Error("denied user insert returned no row");
  const rand = createDeterministicHexFactory(0xc0_2e)(16);
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

describe("connector promotion keeps its HTTP responses byte for byte", () => {
  test("copy answers 201 and its replay 200", async () => {
    record("http.copy", await promote(COPY, BODY_COPY, "golden-copy-key"));
    record("http.copy.replay", await promote(COPY, BODY_COPY, "golden-copy-key"));
    record("http.copy.key-reused", await promote(COPY, BODY_MOVE, "golden-copy-key"));
    record("http.copy.target-exists", await promote(COPY, BODY_COPY, "golden-copy-again"));
  });

  test("move answers 200 and leaves a PROD source behind", async () => {
    record("http.move", await promote(MOVE, BODY_MOVE, "golden-move-key"));
    record("http.move.replay", await promote(MOVE, BODY_MOVE, "golden-move-key"));
    record("http.move.not-dev", await promote(MOVE, BODY_MOVE, "golden-move-again"));
  });

  test("unsafe and unknown sources are rejected", async () => {
    record("http.prod", await promote(PROD, BODY_COPY, "golden-prod-key"));
    record("http.oauth-copy", await promote(OAUTH, BODY_COPY, "golden-oauth-key"));
    record("http.missing", await promote(MISSING, BODY_COPY, "golden-missing-key"));
  });

  test("the request is validated", async () => {
    record("http.no-key", await promote(COPY, BODY_COPY, null));
    record("http.short-key", await promote(COPY, BODY_COPY, "short"));
    record(
      "http.wrong-target",
      await promote(COPY, { target_environment: "dev", strategy: "copy" }, "golden-wrong-target"),
    );
    record(
      "http.bad-strategy",
      await promote(COPY, { target_environment: "prod", strategy: "fork" }, "golden-bad-strategy"),
    );
    record("http.invalid-id", await promote("not-a-uuid", BODY_COPY, "golden-invalid-id"));
  });

  test("permission is checked before the request is validated", async () => {
    record("http.denied", await promote(DENIED, BODY_COPY, "golden-denied-key", deniedKey));
    record("http.denied.invalid", await promote(DENIED, {}, null, deniedKey));
  });

  test("audit trail", async () => {
    record("http.audit", await auditTrail());
  });

  test("the golden file has no stale entries", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });
});
