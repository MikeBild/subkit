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
