// A primary provider that refuses on its usage limit must not take the
// secondary LLM callers down with it, and must not be billed for the answer
// the fallback gave.
//
// Two local HTTP stubs stand in for two real providers: the Anthropic stub
// answers every request with the usage-limit refusal the provider sends, the
// OpenAI-compatible stub answers the chat completion. The in-process mock
// provider cannot carry this case — it runs a separate dispatch path, and a
// mock/mock route is one provider, where a quota refusal correctly does NOT
// fall back. Two stubs make the route cross-provider and put the real SDK
// error parsing and the real fallback in the loop.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { setConfigKey } from "../../config/loader.ts";
import { buildNextSuggestionFrame } from "../../conversations/loop/suggest-next-emitter.ts";
import type { TurnEvent } from "../../conversations/types.ts";
import { conversationMessages, conversations, llmUsage } from "../../db/schema/index.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { LlmProviderError } from "../errors.ts";
import { runSummarizeFlow } from "../flows/summarize.ts";
import { createLlmTestCtx, type LlmTestCtx } from "./setup.ts";

const PRIMARY = "claude-haiku-4-5";
const FALLBACK = "gpt-5.6-sol";
const QUOTA_MESSAGE =
  "You have reached your specified API usage limits. You will regain access on 2026-10-01 at 00:00 UTC.";
const FALLBACK_TEXT = "show the failed runs from today";
const FALLBACK_PROMPT_TOKENS = 321;
const FALLBACK_COMPLETION_TOKENS = 9;

interface Stub {
  server: ReturnType<typeof Bun.serve>;
  hits: number;
  bodies: Array<Record<string, unknown>>;
}

type PrimaryMode = "quota" | "bad_request";

let ctx: LlmTestCtx;
let anthropic: Stub;
let openai: Stub;
let primaryMode: PrimaryMode = "quota";

function startAnthropicStub(): Stub {
  const stub: Stub = { hits: 0, bodies: [], server: undefined as never };
  stub.server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      stub.hits += 1;
      stub.bodies.push((await req.json()) as Record<string, unknown>);
      const message =
        primaryMode === "quota" ? QUOTA_MESSAGE : "messages.0.content: field required";
      return Response.json(
        { type: "error", error: { type: "invalid_request_error", message } },
        { status: 400 },
      );
    },
  });
  return stub;
}

function startOpenAiStub(): Stub {
  const stub: Stub = { hits: 0, bodies: [], server: undefined as never };
  stub.server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      stub.hits += 1;
      const body = (await req.json()) as Record<string, unknown>;
      stub.bodies.push(body);
      return Response.json({
        id: "chatcmpl-stub",
        object: "chat.completion",
        created: 1,
        model: String(body.model ?? FALLBACK),
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: FALLBACK_TEXT },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: FALLBACK_PROMPT_TOKENS,
          completion_tokens: FALLBACK_COMPLETION_TOKENS,
          total_tokens: FALLBACK_PROMPT_TOKENS + FALLBACK_COMPLETION_TOKENS,
        },
      });
    },
  });
  return stub;
}

beforeAll(async () => {
  ctx = await createLlmTestCtx("provider_quota_fallback");
  anthropic = startAnthropicStub();
  openai = startOpenAiStub();
  const leaves: Array<[string, unknown]> = [
    ["llm.provider", "anthropic"],
    ["llm.model", PRIMARY],
    ["llm.suggestion_model", PRIMARY],
    ["llm.fallback_provider", "openai"],
    ["llm.fallback_model", FALLBACK],
    ["llm.providers.anthropic.api_key", "sk-ant-stub"],
    ["llm.providers.anthropic.base_url", `http://127.0.0.1:${anthropic.server.port}/v1`],
    ["llm.providers.openai.api_key", "sk-openai-stub"],
    ["llm.providers.openai.base_url", `http://127.0.0.1:${openai.server.port}/v1`],
  ];
  for (const [leaf, value] of leaves) await setConfigKey(leaf, value, { force: true });
});

afterAll(async () => {
  anthropic.server.stop(true);
  openai.server.stop(true);
  await ctx.cleanup();
});

beforeEach(async () => {
  primaryMode = "quota";
  for (const stub of [anthropic, openai]) {
    stub.hits = 0;
    stub.bodies = [];
  }
  await ctx.testDb.db.delete(llmUsage).where(eq(llmUsage.tenant_id, ctx.tenant_id));
});

async function usageRows() {
  return ctx.testDb.db
    .select()
    .from(llmUsage)
    .where(and(eq(llmUsage.tenant_id, ctx.tenant_id)));
}

describe("a quota-refused primary falls back like the chat turn does", () => {
  test("next-message suggestion is answered by the fallback model", async () => {
    // Persisted the way the turn loop leaves it, and read back through `db`
    // exactly as the loop passes it. No trailing question and no offer: the
    // suggestion needs the model.
    const [conversation] = await ctx.testDb.db
      .insert(conversations)
      .values({ tenant_id: ctx.tenant_id, status: "active" })
      .returning();
    if (!conversation) throw new Error("seed conversation failed");
    await ctx.testDb.db.insert(conversationMessages).values([
      {
        tenant_id: ctx.tenant_id,
        conversation_id: conversation.id,
        role: "user",
        content: { text: "how did the nightly runs go" },
        created_at: new Date(FROZEN_NOW),
      },
      {
        tenant_id: ctx.tenant_id,
        conversation_id: conversation.id,
        role: "assistant",
        content: { text: "Three runs failed overnight. The rest completed." },
        created_at: new Date(FROZEN_NOW + 1000),
      },
    ]);
    const events: ReadonlyArray<TurnEvent> = [{ type: "completed", status: "active" }];

    const frame = await buildNextSuggestionFrame({
      tenant_id: ctx.tenant_id,
      conversation_id: conversation.id,
      events,
      db: ctx.testDb.db,
    });

    if (frame.type !== "next_suggestion") throw new Error("expected a next_suggestion frame");
    expect(anthropic.hits).toBe(1);
    expect(openai.hits).toBe(1);
    expect(openai.bodies[0]?.model).toBe(FALLBACK);
    expect(frame.reason).toBe("model");
    expect(frame.suggestion).toBe(FALLBACK_TEXT);
  });

  test("a background summary completes on the fallback and bills only the fallback", async () => {
    const result = await runSummarizeFlow(
      { tenant_id: ctx.tenant_id, prompt: "Summarize: three nightly runs failed." },
      ctx.testDb.db,
    );

    expect(anthropic.hits).toBe(1);
    expect(openai.hits).toBe(1);
    expect(result.summary).toBe(FALLBACK_TEXT);
    expect(result.model_used).toBe(FALLBACK);
    expect(result.fell_back).toBe(true);

    const rows = await usageRows();
    const answered = rows.filter((r) => r.model === FALLBACK);
    expect(answered).toHaveLength(1);
    expect(answered[0]?.result).toBe("success");
    expect(answered[0]?.prompt_tokens).toBe(FALLBACK_PROMPT_TOKENS);
    expect(answered[0]?.completion_tokens).toBe(FALLBACK_COMPLETION_TOKENS);

    // The refusal is on the ledger — as an error, carrying no tokens.
    const refused = rows.filter((r) => r.model === PRIMARY);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.result).toBe("error");
    expect(refused[0]?.prompt_tokens).toBe(0);
    expect(refused[0]?.completion_tokens).toBe(0);
    expect(refused[0]?.total_tokens).toBe(0);
  });

  test("a genuine request error is not retried on the fallback", async () => {
    primaryMode = "bad_request";

    const err = await runSummarizeFlow(
      { tenant_id: ctx.tenant_id, prompt: "Summarize: three nightly runs failed." },
      ctx.testDb.db,
    ).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(LlmProviderError);
    expect(anthropic.hits).toBe(1);
    expect(openai.hits).toBe(0);
    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.model).toBe(PRIMARY);
    expect(rows[0]?.result).toBe("error");
    expect(rows[0]?.total_tokens).toBe(0);
  });
});
