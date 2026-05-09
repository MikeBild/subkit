// User story: As an operator, I want machine accounts to inherit
// narrow roles rather than being implicit admins.
// Acceptance criteria:
//   - AC1: A metrics_scraper system account is denied workflow:read.
//   - AC2: The default-bot system account remains full admin.
// Spec refs: gap-pass-2 C7 / C8

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { apiKeys, roles, systemAccounts } from "../../db/schema/index.ts";
import { BUILTIN_ROLE_NAMES } from "../../rbac/seed.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx } from "./setup.ts";

let ctx: JourneyCtx;

function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}
function newKey() {
  const rand = randomBytes(24).toString("base64url").slice(0, 32); // allow-random: legacy; review before changing
  const plaintext = `wf_live_${rand}`;
  return { plaintext, prefix: plaintext.slice(0, 12), hash: sha256Hex(plaintext) };
}

async function seedSystemKey(name: string, builtinRoleName: string): Promise<string> {
  const roleRows = await ctx.db
    .select({ id: roles.id })
    .from(roles)
    .where(and(isNull(roles.tenant_id), eq(roles.name, builtinRoleName)))
    .limit(1);
  const role_id = roleRows[0]?.id ?? null;
  const [acct] = await ctx.db
    .insert(systemAccounts)
    .values({ tenant_id: ctx.tenantId, name, role_id })
    .returning();
  const k = newKey();
  await ctx.db.insert(apiKeys).values({
    tenant_id: ctx.tenantId,
    system_account_id: acct!.id,
    prefix: k.prefix,
    token_sha256: k.hash,
    scopes: ["*"],
  });
  return k.plaintext;
}

describe("journey: rbac system account scopes", () => {
  let metricsKey = "";

  beforeAll(async () => {
    ctx = await createJourneyCtx("24-rbac-sys");
    metricsKey = await seedSystemKey("metrics-scraper-24", BUILTIN_ROLE_NAMES.METRICS_SCRAPER);
  }, JOURNEY_HOOK_TIMEOUT);
  afterAll(async () => {
    await ctx.cleanup();
  }, JOURNEY_HOOK_TIMEOUT);

  async function req(key: string, path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${key}`);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    return fetch(`${ctx.baseUrl}${path}`, { ...init, headers });
  }

  test("AC1: metrics_scraper cannot list workflows", async () => {
    const res = await req(metricsKey, "/v1/workflows");
    expect(res.status).toBe(403);
  });

  test("AC2: default-bot (admin) retains full access", async () => {
    // The journey bootstrap seeds the admin API key under ctx.apiKey.
    const res = await req(ctx.apiKey, "/v1/workflows");
    expect(res.status).toBe(200);
  });
});
