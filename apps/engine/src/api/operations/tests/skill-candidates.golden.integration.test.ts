import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import {
  auditLog,
  skillCandidateEvidence,
  skillCandidates,
  users,
} from "../../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../http/tests/setup.ts";
import { FROZEN_NOW } from "../../../test-helpers/determinism/clock.ts";
import { createDeterministicHexFactory } from "../../../test-helpers/determinism/ids.ts";
import { emptyRoleId } from "../../../test-helpers/roles.ts";

const GOLDEN_PATH = new URL("./fixtures/skill-candidates.golden.json", import.meta.url).pathname;
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, string>;
const actual: Record<string, string> = {};
const uuidNames = new Map<string, string>();
const UUID =
  /(?<![0-9a-f-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f-])/g;
const MISSING = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";

let ctx: HttpTestServer;
let deniedKey: string;
let readerKey: string;
let writerKey: string;
const ids: Record<string, string> = {};

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
  overrides: Partial<typeof skillCandidates.$inferInsert> = {},
): Promise<string> {
  const [row] = await ctx.db
    .insert(skillCandidates)
    .values({
      tenant_id: ctx.tenantId,
      scope: "global",
      pattern_kind: "success_pattern",
      title: `Candidate ${label}`,
      body: `Body ${label}`,
      evidence: { note: label },
      confidence: "high",
      status: "proposed",
      fingerprint: `fp-golden-${label}`,
      created_at: new Date(FROZEN_NOW + Object.keys(ids).length * 60_000),
      ...overrides,
    })
    .returning();
  if (!row) throw new Error("candidate insert returned no row");
  ids[label] = row.id;
  return row.id;
}

beforeAll(async () => {
  ctx = await createHttpTestServer("operations_skill_candidates_golden");
  const deniedUser = await seedUser(
    "denied-skill-candidates-operations@test.local",
    await emptyRoleId(ctx.db, ctx.tenantId),
  );
  deniedKey = await mintKey({ user_id: deniedUser }, 0x5c_01);
  readerKey = await mintKey({ user_id: ctx.userId }, 0x5c_02, ["skill:read"]);
  writerKey = await mintKey({ user_id: ctx.userId }, 0x5c_03, ["skill:read", "skill:write"]);
  const alpha = await seedCandidate("alpha");
  await seedCandidate("beta", { confidence: "low", pattern_kind: "failure_pattern" });
  await seedCandidate("gamma");
  await seedCandidate("delta");
  await seedCandidate("rejected", { status: "rejected" });
  await seedCandidate("context", { status: "context" });
  await ctx.db.insert(skillCandidateEvidence).values([
    {
      skill_candidate_id: alpha,
      evidence_type: "step_success",
      summary: "older evidence",
      captured_at: new Date(FROZEN_NOW - 60_000),
    },
    {
      skill_candidate_id: alpha,
      evidence_type: "patch_applied",
      summary: "newer evidence",
      captured_at: new Date(FROZEN_NOW),
    },
  ]);
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

const DIGEST = "0".repeat(64);

describe("skill candidate operations keep their HTTP responses byte for byte", () => {
  test("list", async () => {
    record("http.list", await http("GET", "/v1/skill-candidates"));
    record("http.list.page", await http("GET", "/v1/skill-candidates?limit=2&offset=1"));
    record("http.list.status", await http("GET", "/v1/skill-candidates?status=rejected"));
    record(
      "http.list.filters",
      await http("GET", "/v1/skill-candidates?confidence=low&pattern_kind=failure_pattern"),
    );
    record("http.list.scope", await http("GET", "/v1/skill-candidates?scope=connector"));
    record("http.list.invalid", await http("GET", "/v1/skill-candidates?limit=0"));
    record("http.list.reader", await http("GET", "/v1/skill-candidates", undefined, readerKey));
  });

  test("get and evidence", async () => {
    record("http.get", await http("GET", `/v1/skill-candidates/${ids.alpha}`));
    record("http.get.missing", await http("GET", `/v1/skill-candidates/${MISSING}`));
    record("http.get.invalid", await http("GET", "/v1/skill-candidates/nope"));
    record("http.evidence", await http("GET", `/v1/skill-candidates/${ids.alpha}/evidence`));
    record("http.evidence.empty", await http("GET", `/v1/skill-candidates/${ids.beta}/evidence`));
    record("http.evidence.missing", await http("GET", `/v1/skill-candidates/${MISSING}/evidence`));
  });

  test("reject", async () => {
    record(
      "http.reject",
      await http("POST", `/v1/skill-candidates/${ids.beta}/reject`, { reason: "golden" }),
    );
    record("http.reject.again", await http("POST", `/v1/skill-candidates/${ids.beta}/reject`, {}));
    record("http.reject.missing", await http("POST", `/v1/skill-candidates/${MISSING}/reject`, {}));
    record(
      "http.reject.invalid",
      await http("POST", `/v1/skill-candidates/${ids.gamma}/reject`, { reason: 5 }),
    );
    record("http.reject.get", await http("GET", `/v1/skill-candidates/${ids.beta}`));
  });

  test("approve", async () => {
    record(
      "http.approve.stale",
      await http("POST", `/v1/skill-candidates/${ids.gamma}/approve`, {
        expected_review_digest: DIGEST,
      }),
    );
    record(
      "http.approve.missing",
      await http("POST", `/v1/skill-candidates/${MISSING}/approve`, {}),
    );
    record(
      "http.approve.rejected",
      await http("POST", `/v1/skill-candidates/${ids.rejected}/approve`, {}),
    );
    record(
      "http.approve.context",
      await http("POST", `/v1/skill-candidates/${ids.context}/approve`, {}),
    );
    record(
      "http.approve.writer-active",
      await http(
        "POST",
        `/v1/skill-candidates/${ids.gamma}/approve`,
        { status: "active" },
        writerKey,
      ),
    );
    record(
      "http.approve",
      await http("POST", `/v1/skill-candidates/${ids.gamma}/approve`, {
        title: "Approved golden",
        status: "draft",
      }),
    );
    record(
      "http.approve-batch.api-key",
      await http("POST", "/v1/skill-candidates/approve", {
        candidates: [{ id: ids.delta, expected_review_digest: DIGEST }],
      }),
    );
    record("http.approve-batch.invalid", await http("POST", "/v1/skill-candidates/approve", {}));
    record(
      "http.approve-batch.writer",
      await http(
        "POST",
        "/v1/skill-candidates/approve",
        { candidates: [{ id: ids.delta, expected_review_digest: DIGEST }] },
        writerKey,
      ),
    );
    record(
      "http.approve.writer-draft",
      await http(
        "POST",
        `/v1/skill-candidates/${ids.delta}/approve`,
        { expected_review_digest: DIGEST },
        writerKey,
      ),
    );
  });

  test("permission is checked before the body is validated", async () => {
    const calls: [string, string, unknown][] = [
      ["GET", "/v1/skill-candidates", undefined],
      ["GET", `/v1/skill-candidates/${ids.alpha}`, undefined],
      ["GET", `/v1/skill-candidates/${ids.alpha}/evidence`, undefined],
      ["POST", `/v1/skill-candidates/${ids.alpha}/approve`, { status: "active" }],
      ["POST", "/v1/skill-candidates/approve", {}],
      ["POST", `/v1/skill-candidates/${ids.alpha}/reject`, {}],
      ["HEAD", "/v1/skill-candidates", undefined],
      ["HEAD", `/v1/skill-candidates/${ids.alpha}`, undefined],
      ["HEAD", `/v1/skill-candidates/${ids.alpha}/evidence`, undefined],
      ["POST", "/v1/skill-candidates", {}],
      ["DELETE", `/v1/skill-candidates/${ids.alpha}`, undefined],
      ["POST", `/v1/skill-candidates/${ids.alpha}/evidence`, {}],
      ["GET", `/v1/skill-candidates/${ids.alpha}/reject`, undefined],
      ["GET", "/v1/skill-candidates/approve", undefined],
      ["GET", `/v1/skill-candidates/${ids.alpha}/approve`, undefined],
    ];
    for (const [who, key] of [
      ["denied", deniedKey],
      ["reader", readerKey],
    ] as const) {
      for (const [method, path, body] of calls) {
        record(
          `http.${who} ${method} ${path.replace(ids.alpha as string, "<id>")}`,
          await http(method, path, body, key),
        );
      }
    }
    recordRows("http.denied.audit", await auditRows(eq(auditLog.result, "denied")));
  });

  test("audit trail of the decided candidates", async () => {
    recordRows(
      "http.audit",
      await auditRows(inArray(auditLog.resource_id, [ids.beta, ids.gamma, ids.delta] as string[])),
    );
  });

  test("the golden file has no stale entries", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });
});
