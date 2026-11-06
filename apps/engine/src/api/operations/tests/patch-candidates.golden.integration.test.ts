import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { auditLog, patchCandidates, users } from "../../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../http/tests/setup.ts";
import { FROZEN_NOW } from "../../../test-helpers/determinism/clock.ts";
import { createDeterministicHexFactory } from "../../../test-helpers/determinism/ids.ts";
import { reviewableDiff, seedPatchableWorkflow } from "../../../test-helpers/patch-candidates.ts";
import { emptyRoleId } from "../../../test-helpers/roles.ts";

const GOLDEN_PATH = new URL("./fixtures/patch-candidates.golden.json", import.meta.url).pathname;
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, string>;
const actual: Record<string, string> = {};
const uuidNames = new Map<string, string>();
const UUID =
  /(?<![0-9a-f-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f-])/g;
const MISSING = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";

let ctx: HttpTestServer;
let deniedKey: string;
let readerKey: string;
const ids: Record<string, string> = {};
let workflowId: string;
let preparedVersionId: string;

function uuidName(uuid: string): string {
  if (uuid === MISSING) return "<missing>";
  const known = uuidNames.get(uuid);
  if (known) return known;
  const name = `<uuid:${uuidNames.size + 1}>`;
  uuidNames.set(uuid, name);
  return name;
}

function scrub(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll(ctx.tenantId, "<tenant>")
    .replace(/"20(2[4-9]|[3-9]\d)-\d\d-\d\dT[\d:.]+Z"/g, '"<now>"')
    .replace(/"(trace_id|audit_trace_id|request_id)":"[^"]*"/g, '"$1":"<trace>"')
    .replace(/"review_digest":"[0-9a-f]{64}"/g, '"review_digest":"<digest>"');
}

function record(name: string, value: unknown): void {
  actual[name] = scrub(value).replace(UUID, uuidName);
  expect(actual[name]).toBe(golden[name] as string);
}

function recordRows(name: string, rows: readonly unknown[]): void {
  actual[name] = JSON.stringify(rows.map((row) => scrub(row).replace(UUID, "<id>")).sort());
  expect(actual[name]).toBe(golden[name] as string);
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
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
  return { status: res.status, body: parseBody(text) };
}

function auditRows(where: ReturnType<typeof eq>) {
  return ctx.db
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
    .where(and(eq(auditLog.tenant_id, ctx.tenantId), where));
}

async function mintKey(
  owner: { user_id?: string; system_account_id?: string },
  seed: number,
  scopes: readonly string[] = ["*"],
) {
  const key = `wf_live_${createDeterministicHexFactory(seed)(16)}`;
  await ctx.testDb.pool.query(
    "INSERT INTO subkit.api_keys (tenant_id, user_id, system_account_id, prefix, token_sha256, scopes) VALUES ($1, $2, $3, $4, $5, $6::jsonb)",
    [
      ctx.tenantId,
      owner.user_id ?? null,
      owner.system_account_id ?? null,
      key.slice(0, 12),
      createHash("sha256").update(key).digest("hex"),
      JSON.stringify(scopes),
    ],
  );
  return key;
}

async function seedUser(email: string, role_id: string): Promise<string> {
  const [row] = await ctx.db
    .insert(users)
    .values({ tenant_id: ctx.tenantId, email, role_id })
    .returning();
  if (!row) throw new Error("user insert returned no row");
  return row.id;
}

async function seedCandidate(
  label: string,
  overrides: Partial<typeof patchCandidates.$inferInsert> = {},
): Promise<string> {
  const [row] = await ctx.db
    .insert(patchCandidates)
    .values({
      tenant_id: ctx.tenantId,
      workflow_id: workflowId,
      classification: "safe",
      status: "proposed",
      diff: reviewableDiff(`Fix ${label}`),
      created_at: new Date(FROZEN_NOW + Object.keys(ids).length * 60_000),
      ...overrides,
    })
    .returning();
  if (!row) throw new Error("patch candidate insert returned no row");
  ids[label] = row.id;
  return row.id;
}

beforeAll(async () => {
  ctx = await createHttpTestServer("operations_patch_candidates_golden");
  const deniedUser = await seedUser(
    "denied-patch-candidates-operations@test.local",
    await emptyRoleId(ctx.db, ctx.tenantId),
  );
  deniedKey = await mintKey({ user_id: deniedUser }, 0x9c_01);
  readerKey = await mintKey({ user_id: ctx.userId }, 0x9c_02, ["workflow:read"]);
  workflowId = (await seedPatchableWorkflow(ctx.db, ctx.tenantId, "golden-patch", "Golden Patch"))
    .workflow_id;
  await seedCandidate("alpha");
  await seedCandidate("bare", { classification: "unsafe", diff: { note: "no proposal" } });
  await seedCandidate("rejected", { status: "rejected", closed_reason: "golden" });
  await seedCandidate("doomed");
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

const DIGEST = "0".repeat(64);

describe("patch candidate operations keep their HTTP responses byte for byte", () => {
  test("list", async () => {
    record("http.list", await http("GET", "/v1/patch-candidates"));
    record("http.list.page", await http("GET", "/v1/patch-candidates?limit=2&offset=1&order=asc"));
    record("http.list.status", await http("GET", "/v1/patch-candidates?status=rejected"));
    record("http.list.reviewable", await http("GET", "/v1/patch-candidates?reviewable=true"));
    record("http.list.unreviewable", await http("GET", "/v1/patch-candidates?reviewable=false"));
    record(
      "http.list.workflow",
      await http("GET", `/v1/patch-candidates?workflow_id=${workflowId}`),
    );
    record(
      "http.list.other-workflow",
      await http("GET", `/v1/patch-candidates?workflow_id=${MISSING}`),
    );
    record("http.list.invalid", await http("GET", "/v1/patch-candidates?limit=0"));
  });

  test("get and preview", async () => {
    record("http.get", await http("GET", `/v1/patch-candidates/${ids.alpha}`));
    record("http.get.bare", await http("GET", `/v1/patch-candidates/${ids.bare}`));
    record("http.get.missing", await http("GET", `/v1/patch-candidates/${MISSING}`));
    record("http.get.invalid", await http("GET", "/v1/patch-candidates/nope"));
    record("http.preview", await http("GET", `/v1/patch-candidates/${ids.alpha}/preview`));
    record("http.preview.bare", await http("GET", `/v1/patch-candidates/${ids.bare}/preview`));
    record("http.preview.missing", await http("GET", `/v1/patch-candidates/${MISSING}/preview`));
  });

  test("dry-run", async () => {
    record("http.dry-run", await http("POST", `/v1/patch-candidates/${ids.alpha}/dry-run`));
    record("http.dry-run.bare", await http("POST", `/v1/patch-candidates/${ids.bare}/dry-run`));
    record("http.dry-run.missing", await http("POST", `/v1/patch-candidates/${MISSING}/dry-run`));
  });

  test("reject", async () => {
    record(
      "http.reject",
      await http("POST", `/v1/patch-candidates/${ids.doomed}/reject`, { reason: "golden" }),
    );
    record(
      "http.reject.again",
      await http("POST", `/v1/patch-candidates/${ids.doomed}/reject`, {}),
    );
    record("http.reject.missing", await http("POST", `/v1/patch-candidates/${MISSING}/reject`, {}));
    record(
      "http.reject.invalid",
      await http("POST", `/v1/patch-candidates/${ids.alpha}/reject`, { reason: 5 }),
    );
  });

  test("prepare and approve", async () => {
    record(
      "http.prepare.stale",
      await http("POST", `/v1/patch-candidates/${ids.alpha}/prepare`, {
        expected_review_digest: DIGEST,
      }),
    );
    record(
      "http.prepare.missing",
      await http("POST", `/v1/patch-candidates/${MISSING}/prepare`, {
        expected_review_digest: DIGEST,
      }),
    );
    record(
      "http.prepare.invalid",
      await http("POST", `/v1/patch-candidates/${ids.alpha}/prepare`, {}),
    );
    record(
      "http.approve.stale",
      await http("POST", `/v1/patch-candidates/${ids.alpha}/approve`, {
        expected_review_digest: DIGEST,
      }),
    );
    record(
      "http.approve.rejected",
      await http("POST", `/v1/patch-candidates/${ids.rejected}/approve`, {
        expected_review_digest: DIGEST,
      }),
    );
    record(
      "http.approve.missing",
      await http("POST", `/v1/patch-candidates/${MISSING}/approve`, {
        expected_review_digest: DIGEST,
      }),
    );
    record(
      "http.approve.invalid",
      await http("POST", `/v1/patch-candidates/${ids.alpha}/approve`, {}),
    );
  });

  test("prepare with the reviewed digest", async () => {
    const preview = await http("GET", `/v1/patch-candidates/${ids.alpha}/preview`);
    const digest = (preview.body as { review_digest: string }).review_digest;
    const prepared = await http("POST", `/v1/patch-candidates/${ids.alpha}/prepare`, {
      expected_review_digest: digest,
    });
    preparedVersionId = (prepared.body as { workflow_version_id: string }).workflow_version_id;
    record("http.prepare", prepared);
    record("http.prepare.get", await http("GET", `/v1/patch-candidates/${ids.alpha}`));
  });

  test("permission is checked before the body is validated", async () => {
    const id = ids.alpha as string;
    const calls: [string, string, unknown][] = [
      ["GET", "/v1/patch-candidates", undefined],
      ["GET", `/v1/patch-candidates/${id}`, undefined],
      ["GET", `/v1/patch-candidates/${id}/preview`, undefined],
      ["POST", `/v1/patch-candidates/${id}/dry-run`, undefined],
      ["POST", `/v1/patch-candidates/${id}/approve`, {}],
      ["POST", `/v1/patch-candidates/${id}/reject`, {}],
      ["POST", `/v1/patch-candidates/${id}/prepare`, {}],
      ["HEAD", "/v1/patch-candidates", undefined],
      ["HEAD", `/v1/patch-candidates/${id}`, undefined],
      ["HEAD", `/v1/patch-candidates/${id}/preview`, undefined],
      ["POST", "/v1/patch-candidates", {}],
      ["DELETE", `/v1/patch-candidates/${id}`, undefined],
      ["POST", `/v1/patch-candidates/${id}/preview`, {}],
      ["GET", `/v1/patch-candidates/${id}/dry-run`, undefined],
      ["GET", `/v1/patch-candidates/${id}/approve`, undefined],
      ["GET", `/v1/patch-candidates/${id}/reject`, undefined],
      ["GET", `/v1/patch-candidates/${id}/prepare`, undefined],
    ];
    for (const [who, key] of [
      ["denied", deniedKey],
      ["reader", readerKey],
    ] as const) {
      for (const [method, path, body] of calls) {
        record(
          `http.${who} ${method} ${path.replace(id, "<id>")}`,
          await http(method, path, body, key),
        );
      }
    }
    recordRows("http.denied.audit", await auditRows(eq(auditLog.result, "denied")));
  });

  test("audit trail of the reviewed candidates", async () => {
    recordRows(
      "http.audit",
      await auditRows(inArray(auditLog.resource_id, [ids.alpha, ids.bare, ids.doomed] as string[])),
    );
  });

  test("approve with the reviewed digest", async () => {
    const preview = await http("GET", `/v1/patch-candidates/${ids.alpha}/preview`);
    const digest = (preview.body as { review_digest: string }).review_digest;
    const authority = {
      expected_manifest_digest: DIGEST,
      execution_environment: "dev",
      valid_from: new Date(FROZEN_NOW).toISOString(),
    };
    const approve = (body: unknown, key?: string) =>
      http("POST", `/v1/patch-candidates/${ids.alpha}/approve`, body, key);
    record(
      "http.approve.reviewed.reader",
      await approve({ expected_review_digest: digest }, readerKey),
    );
    record(
      "http.approve.authority.changed",
      await approve({
        expected_review_digest: digest,
        execution_authority: { ...authority, workflow_version_id: MISSING },
      }),
    );
    record(
      "http.approve.authority.api-key",
      await approve({
        expected_review_digest: digest,
        execution_authority: { ...authority, workflow_version_id: preparedVersionId },
      }),
    );
    record("http.approve.reviewed", await approve({ expected_review_digest: digest }));
    record("http.approve.reviewed.again", await approve({ expected_review_digest: digest }));
    const rows = await auditRows(eq(auditLog.resource_id, ids.alpha as string));
    recordRows(
      "http.approve.audit",
      rows.filter((row) => row.action === "patch_candidate.approved"),
    );
  });

  test("the golden file has no stale entries", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });
});
