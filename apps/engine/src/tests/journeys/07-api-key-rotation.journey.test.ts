import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { apiKeys, systemAccounts, users } from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

const TEST_NOW_MS = getTestNow();

let ctx: JourneyCtx;
let victimKeyId = "";
let victimKeyPlain = "";

beforeAll(async () => {
  ctx = await createJourneyCtx("key-rotation");

  const [user] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "rotate@test.local",
      role_id: await builtinRoleId(ctx.db, "admin"),
    })
    .returning();
  const issueRes = await journeyFetch(ctx, "/v1/identity/api-keys", {
    method: "POST",
    body: JSON.stringify({
      owner_kind: "user",
      owner_id: user!.id,
      scopes: ["*"],
    }),
  });
  expect(issueRes.status).toBe(201);
  const issued = (await issueRes.json()) as { id: string; plaintext_key: string };
  victimKeyId = issued.id;
  victimKeyPlain = issued.plaintext_key;

  void systemAccounts;
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

async function probeWith(apiKey: string): Promise<number> {
  const res = await fetch(`${ctx.baseUrl}/v1/identity/tenants`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  return res.status;
}

describe("journey: api key rotation", () => {
  test("AC1: the seeded key authenticates pre-rotation", async () => {
    expect(await probeWith(victimKeyPlain)).toBe(200);
  });

  test("AC2: rotation returns a new plaintext; both keys work during overlap", async () => {
    const rotateRes = await journeyFetch(ctx, `/v1/identity/api-keys/${victimKeyId}/rotate`, {
      method: "POST",
      body: JSON.stringify({ overlap_minutes: 60 }),
    });
    expect(rotateRes.status).toBe(200);
    const rotated = (await rotateRes.json()) as {
      old: { id: string; rotating_out_at: string | null };
      new: { id: string; plaintext_key: string };
    };
    expect(rotated.old.rotating_out_at).toBeTruthy();
    expect(rotated.new.plaintext_key).toBeTruthy();

    expect(await probeWith(victimKeyPlain)).toBe(200);
    expect(await probeWith(rotated.new.plaintext_key)).toBe(200);

    (globalThis as unknown as { __j7_new?: string }).__j7_new = rotated.new.plaintext_key;
  });

  test("AC3: once rotating_out_at is in the past, the old key is rejected", async () => {
    await ctx.db
      .update(apiKeys)
      .set({ rotating_out_at: new Date(TEST_NOW_MS - 60_000) })
      .where(eq(apiKeys.id, victimKeyId));

    expect(await probeWith(victimKeyPlain)).toBe(401);
    const newPlain = (globalThis as unknown as { __j7_new?: string }).__j7_new;
    expect(newPlain).toBeTruthy();
    expect(await probeWith(newPlain!)).toBe(200);
  });
});
