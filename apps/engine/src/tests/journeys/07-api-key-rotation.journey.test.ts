// User story: As a platform operator, I want to rotate an API key with
// an overlap window so callers can swap credentials without a service
// outage.
// Acceptance criteria:
//   - AC1: The original key authenticates before rotation.
//   - AC2: After rotation, both the old and new plaintexts work while
//          `rotating_out_at` is in the future.
//   - AC3: Once `rotating_out_at` is in the past, the old key is
//          rejected but the new key keeps working.
// Spec refs: docs/07-security-governance.md

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { apiKeys, systemAccounts, users } from "../../db/schema/index.ts";
import { createJourneyCtx, type JourneyCtx, journeyFetch } from "./setup.ts";

const TEST_NOW_MS = 1_700_000_000_000;

let ctx: JourneyCtx;
let victimKeyId = "";
let victimKeyPlain = "";

beforeAll(async () => {
  ctx = await createJourneyCtx("key-rotation");

  // Seed a second user + issue a fresh key we can safely rotate (the
  // shared admin key is used for control-plane calls below).
  const [user] = await ctx.db
    .insert(users)
    .values({ tenant_id: ctx.tenantId, email: "rotate@test.local", role: "admin" })
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

  // Touch unused import so biome doesn't complain.
  void systemAccounts;
}, 60_000);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
});

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

    // Stash the new plaintext for AC3.
    (globalThis as unknown as { __j7_new?: string }).__j7_new = rotated.new.plaintext_key;
  });

  test("AC3: once rotating_out_at is in the past, the old key is rejected", async () => {
    // Force the overlap window into the past.
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
