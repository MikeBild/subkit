// The Slack url_verification handshake is the first thing Slack does
// when an Events API subscription URL is configured — and it MUST be
// echoed back as 200 with `{ challenge }` *before* signature
// verification fires (the request from Slack's verifier is unsigned).
//
// The plan's Verification section lists this scenario as scenario #3
// but no test covered it. AC1 in the journey suite tests HMAC verify,
// not the challenge short-circuit. This test closes that gap.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("chat-urlverif");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("POST /v1/chat/slack/events — url_verification handshake", () => {
  test("echoes the challenge with 200 even without a signature header", async () => {
    const challenge = "abc123-challenge-token-from-slack";
    const res = await fetch(`${ctx.baseUrl}/v1/chat/slack/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "url_verification", challenge }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { challenge: string };
    expect(body.challenge).toBe(challenge);
  });
});
