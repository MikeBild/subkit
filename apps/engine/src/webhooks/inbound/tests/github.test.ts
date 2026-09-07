// GitHub native verifier tests.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { handleInbound } from "../service.ts";
import { createInboundCtx, type InboundTestCtx } from "./setup.ts";

const SECRET = "github-secret-0123456789";

function githubSig(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

let ctx: InboundTestCtx;

beforeAll(async () => {
  ctx = await createInboundCtx("github");
  await ctx.grantAuthority();
  await ctx.createBinding({
    slug: "gh-push",
    verifier: "github",
    secret: SECRET,
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("inbound: github verifier", () => {
  test("accepts a valid x-hub-signature-256", async () => {
    const body = JSON.stringify({ ref: "refs/heads/main" });
    const delivery = randomUUID(); // allow-random: legacy; review before changing
    const sig = githubSig(SECRET, body);
    const outcome = await handleInbound(
      { db: ctx.db, boss: ctx.boss },
      {
        slug: "gh-push",
        rawBody: body,
        headers: {
          "x-github-delivery": delivery,
          "x-github-event": "push",
          "x-hub-signature-256": sig,
        },
      },
    );
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("expected ok");
    expect(outcome.normalized.id).toBe(delivery);
    expect(outcome.normalized.type).toBe("push");
  });

  test("rejects a bad signature", async () => {
    const body = JSON.stringify({ ref: "refs/heads/dev" });
    const delivery = randomUUID(); // allow-random: legacy; review before changing
    const badSig = githubSig("wrong-secret", body);
    const outcome = await handleInbound(
      { db: ctx.db, boss: ctx.boss },
      {
        slug: "gh-push",
        rawBody: body,
        headers: {
          "x-github-delivery": delivery,
          "x-github-event": "push",
          "x-hub-signature-256": badSig,
        },
      },
    );
    expect(outcome.status).toBe("denied");
  });
});
