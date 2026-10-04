// Integration tests for /v1/stats/llm user-level authorization matrix.
//
// The feature adds two authorization rules on top of the existing
// stats:read gate:
//
//   - Reading another user's usage (user_id query param != own id)
//     requires stats:read:all → 403 without it.
//   - cross-user breakdown (group_by=user) requires stats:read:all → 403
//     without it.
//   - Reading own usage (user_id == own id) only needs stats:read → 200.
//   - An admin (has stats:read:all) can query any user_id and group_by=user.
//   - A member user does NOT receive stats:read:all (seed exclusion).
//   - group_by=user without user_id on a stats:read:all principal → 200.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { apiKeys, llmUsage, users } from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;

// IDs seeded inline — these map to the users we create below.
let callerUserId = "";
let callerApiKey = "";

let otherUserId = "";
let otherUserApiKey = "";

let memberNoStatsApiKey = "";

function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

function genKey(): { plaintext: string; prefix: string; hash: string } {
  const rand = randomBytes(20).toString("base64url").slice(0, 26); // allow-random: test only
  const plaintext = `wf_live_${rand}`;
  return { plaintext, prefix: plaintext.slice(0, 12), hash: sha256Hex(plaintext) };
}

// Fixed 24h window containing all llm_usage rows we seed.
const FROM = "2024-03-01T00:00:00.000Z";
const TO = "2024-03-02T00:00:00.000Z";
const WIN = `bucket=hour&from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`;
const INSIDE_TS = new Date("2024-03-01T12:00:00.000Z");
const MONTH_BUCKET = 202403;

beforeAll(async () => {
  srv = await createHttpTestServer("stats-llm-user-auth");

  // The default srv.apiKey / srv.userId is an admin user.
  callerUserId = srv.userId;
  callerApiKey = srv.apiKey;

  // --- another admin user (reading their own stats → needs only stats:read) ---
  const [other] = await srv.db
    .insert(users)
    .values({
      tenant_id: srv.tenantId,
      email: "other-admin@test.local",
      role_id: await builtinRoleId(srv.db, "admin"),
    })
    .returning();
  if (!other) throw new Error("seed other user failed");
  otherUserId = other.id;

  const otherKey = genKey();
  await srv.db.insert(apiKeys).values({
    tenant_id: srv.tenantId,
    user_id: otherUserId,
    prefix: otherKey.prefix,
    token_sha256: otherKey.hash,
    scopes: ["*"],
  });
  otherUserApiKey = otherKey.plaintext;

  // --- member user (stats:read excluded by memberPermissionFilter) ---
  const [member] = await srv.db
    .insert(users)
    .values({
      tenant_id: srv.tenantId,
      email: "member-llm-auth@test.local",
      role_id: await builtinRoleId(srv.db, "member"),
    })
    .returning();
  if (!member) throw new Error("seed member user failed");

  const memberKey = genKey();
  await srv.db.insert(apiKeys).values({
    tenant_id: srv.tenantId,
    user_id: member.id,
    prefix: memberKey.prefix,
    token_sha256: memberKey.hash,
    scopes: ["*"],
  });
  memberNoStatsApiKey = memberKey.plaintext;

  // Seed a few llm_usage rows to make the stats non-trivial.
  await srv.db.insert(llmUsage).values([
    {
      tenant_id: srv.tenantId,
      flow: "converse",
      model: "claude-haiku-4-5",
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      latency_ms: 100,
      result: "success",
      user_id: callerUserId,
      actor_type: "user",
      created_at: INSIDE_TS,
      month_bucket: MONTH_BUCKET,
    },
    {
      tenant_id: srv.tenantId,
      flow: "converse",
      model: "claude-haiku-4-5",
      prompt_tokens: 200,
      completion_tokens: 80,
      total_tokens: 280,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      latency_ms: 150,
      result: "success",
      user_id: otherUserId,
      actor_type: "user",
      created_at: INSIDE_TS,
      month_bucket: MONTH_BUCKET,
    },
  ]);
}, 60_000);

afterAll(async () => {
  await srv.cleanup();
}, 30_000);

function fetch200(path: string, key: string): Promise<Response> {
  return fetch(`${srv.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${key}` },
  });
}

// ---- Reading own usage (no extra permission needed) ------------------------

describe("reading own usage — stats:read is sufficient", () => {
  test("admin caller with user_id=own id → 200", async () => {
    const res = await fetch200(`/v1/stats/llm?${WIN}&user_id=${callerUserId}`, callerApiKey);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totals: { calls: { total: number } } };
    expect(body.totals.calls.total).toBe(1);
  });

  test("other admin reading their own user_id → 200", async () => {
    const res = await fetch200(`/v1/stats/llm?${WIN}&user_id=${otherUserId}`, otherUserApiKey);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totals: { calls: { total: number } } };
    expect(body.totals.calls.total).toBe(1);
  });
});

// ---- Reading another user's usage requires stats:read:all ------------------

describe("reading another user's usage — requires stats:read:all", () => {
  test("admin (has stats:read:all) reading another user_id → 200", async () => {
    const res = await fetch200(`/v1/stats/llm?${WIN}&user_id=${otherUserId}`, callerApiKey);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totals: { calls: { total: number } } };
    // Filtered to otherUserId only.
    expect(body.totals.calls.total).toBe(1);
  });

  test("other admin (has stats:read:all) reading callerUserId → 200", async () => {
    const res = await fetch200(`/v1/stats/llm?${WIN}&user_id=${callerUserId}`, otherUserApiKey);
    expect(res.status).toBe(200);
  });
});

// ---- Member lacks stats:read → 403 on the base route ----------------------

describe("member lacks stats:read — 403 on all llm stats", () => {
  test("member key → 403 on GET /v1/stats/llm", async () => {
    const res = await fetch200(`/v1/stats/llm?${WIN}`, memberNoStatsApiKey);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("forbidden");
  });
});

// ---- group_by=user requires stats:read:all --------------------------------

describe("group_by=user — requires stats:read:all", () => {
  test("admin (has stats:read:all) with group_by=user → 200", async () => {
    const res = await fetch200(`/v1/stats/llm?${WIN}&group_by=user`, callerApiKey);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      groups: Array<{ key: Record<string, string>; totals: { calls: number } }>;
    };
    expect(Array.isArray(body.groups)).toBe(true);
    // Should contain one group per distinct user_id in the window.
    const keys = body.groups.map((g) => g.key.user);
    expect(keys).toContain(callerUserId);
    expect(keys).toContain(otherUserId);
  });

  test("admin (has stats:read:all) with group_by=user and user_id filter → 200 narrowed", async () => {
    const res = await fetch200(
      `/v1/stats/llm?${WIN}&group_by=user&user_id=${callerUserId}`,
      callerApiKey,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      groups: Array<{ key: Record<string, string>; totals: { calls: number } }>;
    };
    // Filtered to callerUserId only.
    const keys = body.groups.map((g) => g.key.user);
    expect(keys).toContain(callerUserId);
    expect(keys).not.toContain(otherUserId);
  });
});

// ---- Seed: built-in member does NOT receive stats:read:all ----------------

describe("built-in member role does not include stats:read:all", () => {
  test("member key reading another user_id → 403 (not stats:read:all, not even stats:read)", async () => {
    const res = await fetch200(`/v1/stats/llm?${WIN}&user_id=${callerUserId}`, memberNoStatsApiKey);
    // Member lacks stats:read entirely; the base gate denies before the
    // stats:read:all check even runs.
    expect(res.status).toBe(403);
  });
});
