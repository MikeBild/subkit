import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { conversations, llmUsage } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;

const FROM = "2026-03-02T00:00:00.000Z";
const TO = "2026-03-03T00:00:00.000Z";
const WIN = `bucket=day&tz=UTC&from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`;
const AT = new Date("2026-03-02T09:00:00.000Z");

let cachedConversationId = "";
let uncachedConversationId = "";

interface PromptCache {
  reported_calls: number;
  reported_prompt_tokens: number;
  reported_cache_read_tokens: number;
  hit_percent: number | null;
}

interface Envelope {
  groups: Array<{ key: Record<string, string>; totals: { prompt_cache: PromptCache } }>;
  totals: { prompt_cache: PromptCache };
}

function usage(
  conversation_id: string,
  prompt: number,
  cacheRead: number,
  reported: boolean | null,
) {
  return {
    tenant_id: srv.tenantId,
    flow: "converse",
    model: "claude-haiku-4-5",
    prompt_tokens: prompt,
    completion_tokens: 10,
    total_tokens: prompt + 10,
    cache_read_tokens: cacheRead,
    cache_creation_tokens: 0,
    cache_reported: reported,
    latency_ms: 500,
    result: "success",
    created_at: AT,
    month_bucket: 202603,
    user_id: srv.userId,
    actor_type: "user",
    conversation_id,
  };
}

beforeAll(async () => {
  srv = await createHttpTestServer("stats-llm-prompt-cache");
  const [cached, uncached] = await srv.db
    .insert(conversations)
    .values([
      { tenant_id: srv.tenantId, status: "active", owner_id: srv.userId },
      { tenant_id: srv.tenantId, status: "active", owner_id: srv.userId },
    ])
    .returning();
  if (!cached || !uncached) throw new Error("seed conversations failed");
  cachedConversationId = cached.id;
  uncachedConversationId = uncached.id;
  await srv.db
    .insert(llmUsage)
    .values([
      usage(cachedConversationId, 1000, 600, true),
      usage(cachedConversationId, 1000, 200, true),
      usage(cachedConversationId, 5000, 0, null),
      usage(uncachedConversationId, 4000, 0, false),
    ]);
});

afterAll(async () => {
  await srv?.cleanup();
});

async function llmStats(query: string): Promise<Envelope> {
  const res = await fetch(`${srv.baseUrl}/v1/stats/llm?${WIN}${query}`, {
    headers: { authorization: `Bearer ${srv.apiKey}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Envelope;
}

describe("prompt cache hits in the LLM stats", () => {
  test("each conversation carries its cache hit share over the calls that reported cache figures", async () => {
    const body = await llmStats("&group_by=conversation");
    const byConversation = new Map(body.groups.map((g) => [g.key.conversation, g.totals]));
    expect(byConversation.get(cachedConversationId)?.prompt_cache).toEqual({
      reported_calls: 2,
      reported_prompt_tokens: 2000,
      reported_cache_read_tokens: 800,
      hit_percent: 40,
    });
    expect(byConversation.get(uncachedConversationId)?.prompt_cache).toEqual({
      reported_calls: 0,
      reported_prompt_tokens: 0,
      reported_cache_read_tokens: 0,
      hit_percent: null,
    });
  });

  test("the workspace total carries the same share over the whole window", async () => {
    const body = await llmStats("");
    expect(body.totals.prompt_cache).toEqual({
      reported_calls: 2,
      reported_prompt_tokens: 2000,
      reported_cache_read_tokens: 800,
      hit_percent: 40,
    });
    expect(body.groups[0]?.totals.prompt_cache.hit_percent).toBe(40);
  });
});
