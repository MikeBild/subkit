// Inbound skip-path (verify: "none") + unknown-verifier denial tests.
//
//   * A `native_verifier_config.skip === true` binding bypasses the
//     signature check. The stored secret must never be decrypted on
//     that path — a malformed/placeholder ciphertext must NOT surface
//     as an HTTP 500; a matching event must be accepted.
//   * A stored `verifier` outside {standard, github, stripe} must be
//     denied with an actionable hint (not a bare "unknown_verifier").

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { webhooksInbound } from "../../../db/schema/index.ts";
import { handleInbound } from "../service.ts";
import { createInboundCtx, type InboundTestCtx } from "./setup.ts";

let ctx: InboundTestCtx;

// A ciphertext triple that `decryptSecret` cannot parse: the IV is 4
// bytes, not the required 12, so any decrypt attempt throws
// `CryptoError("iv length 4, expected 12")`. The skip path must never
// reach it.
const GARBAGE_SECRET = {
  secret_ciphertext: Buffer.from("garbage-ciphertext"),
  secret_iv: Buffer.from([0, 1, 2, 3]),
  secret_auth_tag: Buffer.from([0, 1, 2, 3]),
};

async function insertRawBinding(params: {
  slug: string;
  verifier: string;
  native_verifier_config: Record<string, unknown> | null;
}): Promise<string> {
  const [row] = await ctx.db
    .insert(webhooksInbound)
    .values({
      tenant_id: ctx.tenantId,
      slug: params.slug,
      workflow_id: ctx.workflowId,
      verifier: params.verifier,
      native_verifier_config: params.native_verifier_config,
      ...GARBAGE_SECRET,
      active: true,
      origin: "trigger",
    })
    .returning();
  if (!row) throw new Error("raw binding insert failed");
  return row.id;
}

beforeAll(async () => {
  ctx = await createInboundCtx("skip-verifier");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("inbound: skip path + unknown verifier", () => {
  test("skip=true with a garbage secret does not crash and accepts a matching event", async () => {
    const id = await insertRawBinding({
      slug: "skip-accept",
      verifier: "standard",
      native_verifier_config: { source: "internal", events: ["ping"], skip: true },
    });
    const body = JSON.stringify({ hello: "world" });
    const webhookId = randomUUID(); // allow-random: unique replay id per delivery
    const outcome = await handleInbound(
      { db: ctx.db, boss: ctx.boss },
      {
        slug: "skip-accept",
        rawBody: body,
        headers: {
          "webhook-id": webhookId,
          "webhook-type": "ping",
        },
      },
    );
    // Must NOT throw a CryptoError → HTTP 500. Must accept.
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("expected ok");
    expect(outcome.inbound_id).toBe(id);
    expect(outcome.normalized.id).toBe(webhookId);
    expect(outcome.normalized.type).toBe("ping");
  });

  test("skip=true with empty events accepts an untyped delivery (synthesized id)", async () => {
    await insertRawBinding({
      slug: "skip-any",
      verifier: "standard",
      native_verifier_config: { source: "internal", events: [], skip: true },
    });
    const body = JSON.stringify({ any: true });
    const outcome = await handleInbound(
      { db: ctx.db, boss: ctx.boss },
      { slug: "skip-any", rawBody: body, headers: {} },
    );
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("expected ok");
    // No webhook-id header → id is derived from a body hash so replay
    // dedup still works; type falls back to "unknown".
    const expectedId = `skip-${createHash("sha256").update(body).digest("hex").slice(0, 32)}`;
    expect(outcome.normalized.id).toBe(expectedId);
    expect(outcome.normalized.type).toBe("unknown");
  });

  test("skip=true + non-empty events + missing webhook-type denies event_not_subscribed (no crash)", async () => {
    // Documented behavior: a trusted (skip) ingress still honors an
    // explicit event allow-list. A delivery without a `webhook-type`
    // header normalizes to type "unknown" and is filtered out — a
    // clean 401 denial, never a 500 from touching the secret.
    await insertRawBinding({
      slug: "skip-filtered",
      verifier: "standard",
      native_verifier_config: { source: "internal", events: ["ping"], skip: true },
    });
    const outcome = await handleInbound(
      { db: ctx.db, boss: ctx.boss },
      { slug: "skip-filtered", rawBody: JSON.stringify({ x: 1 }), headers: {} },
    );
    expect(outcome.status).toBe("denied");
    if (outcome.status !== "denied") throw new Error("expected denied");
    expect(outcome.reason).toBe("event_not_subscribed");
  });

  test("real verifier + undecryptable stored secret denies secret_undecryptable (no 500)", async () => {
    // The non-skip twin of the first test: a binding with a REAL
    // verifier whose stored envelope is corrupt (legacy/hand-written
    // row). The decrypt failure must become a clean 401 denial with a
    // rotation hint — never an unhandled CryptoError → HTTP 500 on the
    // public ingress.
    const id = await insertRawBinding({
      slug: "garbage-secret-verify",
      verifier: "standard",
      native_verifier_config: { source: "internal", events: [] },
    });
    const outcome = await handleInbound(
      { db: ctx.db, boss: ctx.boss },
      {
        slug: "garbage-secret-verify",
        rawBody: JSON.stringify({ x: 1 }),
        headers: { "webhook-id": randomUUID() }, // allow-random: unique replay id per delivery
      },
    );
    expect(outcome.status).toBe("denied");
    if (outcome.status !== "denied") throw new Error("expected denied");
    expect(outcome.reason).toBe("secret_undecryptable");
    expect(outcome.inbound_id).toBe(id);
    expect(outcome.hint).toBeString();
    expect(outcome.hint).toContain("rotate");
  });

  test("unknown stored verifier denies with an actionable hint", async () => {
    // A legacy/hand-written row that stored the trigger token "none" in
    // the verifier column. Verifier resolution runs before any decrypt,
    // so the garbage secret never surfaces.
    const id = await insertRawBinding({
      slug: "bad-verifier",
      verifier: "none",
      native_verifier_config: { source: "internal", events: [] },
    });
    const outcome = await handleInbound(
      { db: ctx.db, boss: ctx.boss },
      { slug: "bad-verifier", rawBody: "{}", headers: {} },
    );
    expect(outcome.status).toBe("denied");
    if (outcome.status !== "denied") throw new Error("expected denied");
    expect(outcome.reason).toBe("unknown_verifier");
    expect(outcome.inbound_id).toBe(id);
    expect(outcome.hint).toBeString();
    // Actionable: names the accepted values and the verify:"none" mapping.
    expect(outcome.hint).toContain("standard");
    expect(outcome.hint).toContain("github");
    expect(outcome.hint).toContain("stripe");
    expect(outcome.hint).toContain('verify:"none"');
    expect(outcome.hint).toContain("skip=true");
  });
});
