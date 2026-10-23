import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import {
  apiKeys,
  conversations,
  executions,
  llmUsage,
  tenants,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;

const FROM = "2026-02-02T00:00:00.000Z";
const TO = "2026-02-04T00:00:00.000Z";
const WIN = `bucket=day&tz=UTC&from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`;
const DAY_ONE = new Date("2026-02-02T09:00:00.000Z");
const DAY_TWO = new Date("2026-02-03T09:00:00.000Z");

let conversationId = "";
let untitledConversationId = "";
let workflowId = "";
let firstRunId = "";
let secondRunId = "";
let statsOnlyKey = "";
let noConversationReadKey = "";
let otherTenantConversationId = "";

function scopedKey(): { plaintext: string; prefix: string; hash: string } {
  const rand = randomBytes(20).toString("base64url").slice(0, 26); // allow-random: test only
  const plaintext = `wf_live_${rand}`;
  return {
    plaintext,
    prefix: plaintext.slice(0, 12),
    hash: createHash("sha256").update(plaintext).digest("hex"),
  };
}

async function issueKey(scopes: string[]): Promise<string> {
  const key = scopedKey();
  await srv.db.insert(apiKeys).values({
    tenant_id: srv.tenantId,
    user_id: srv.userId,
    prefix: key.prefix,
    token_sha256: key.hash,
    scopes,
  });
  return key.plaintext;
}

function usage(values: {
  tenantId?: string;
  flow?: string;
  prompt?: number;
  completion?: number;
  cacheRead?: number;
  result?: string;
  at?: Date;
  conversationId?: string | null;
  executionId?: string | null;
}) {
  const prompt = values.prompt ?? 100_000;
  const completion = values.completion ?? 0;
  return {
    tenant_id: values.tenantId ?? srv.tenantId,
    flow: values.flow ?? "converse",
    model: "claude-haiku-4-5",
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    cache_read_tokens: values.cacheRead ?? 0,
    cache_creation_tokens: 0,
    latency_ms: 800,
    result: values.result ?? "success",
    created_at: values.at ?? DAY_ONE,
    month_bucket: 202602,
    user_id: srv.userId,
    actor_type: "user",
    conversation_id: values.conversationId ?? null,
    execution_id: values.executionId ?? null,
  };
}

async function get(path: string, key = srv.apiKey): Promise<Response> {
  return fetch(`${srv.baseUrl}${path}`, { headers: { authorization: `Bearer ${key}` } });
}

interface Group {
  key: Record<string, string>;
  cost?: { amount: number; cache_savings: number };
  conversation?: { title: string | null; owner_id: string | null; updated_at: string };
  model_price?: { input_per_mtok: number; output_per_mtok: number; cache_read_per_mtok: number };
  buckets: Array<{ ts: string; cost?: { amount: number } }>;
  totals: { calls: number; result: Record<string, number> };
}

beforeAll(async () => {
  srv = await createHttpTestServer("stats-llm-breakdown");
  const db = srv.db;

  const [titled] = await db
    .insert(conversations)
    .values({
      tenant_id: srv.tenantId,
      status: "active",
      owner_id: srv.userId,
      title: "Wochenbericht zusammenfassen",
    })
    .returning();
  const [untitled] = await db
    .insert(conversations)
    .values({ tenant_id: srv.tenantId, status: "active", owner_id: srv.userId })
    .returning();
  if (!titled || !untitled) throw new Error("seed conversations failed");
  conversationId = titled.id;
  untitledConversationId = untitled.id;

  const [other] = await db
    .insert(tenants)
    .values({ slug: "t-llm-breakdown-other", display_name: "Other" })
    .returning();
  if (!other) throw new Error("seed other tenant failed");
  const [foreign] = await db
    .insert(conversations)
    .values({ tenant_id: other.id, status: "active", title: "Fremde Unterhaltung" })
    .returning();
  if (!foreign) throw new Error("seed foreign conversation failed");
  otherTenantConversationId = foreign.id;

  const [wf] = await db
    .insert(workflows)
    .values({
      tenant_id: srv.tenantId,
      slug: "wf-breakdown",
      name: "Breakdown",
      lifecycle: "active",
    })
    .returning();
  if (!wf) throw new Error("seed workflow failed");
  workflowId = wf.id;
  const [version] = await db
    .insert(workflowVersions)
    .values({ tenant_id: srv.tenantId, workflow_id: wf.id, version: 1, dag: { steps: [] } })
    .returning();
  if (!version) throw new Error("seed version failed");
  const runs = await db
    .insert(executions)
    .values(
      [DAY_ONE, DAY_TWO].map((started_at) => ({
        tenant_id: srv.tenantId,
        workflow_id: wf.id,
        workflow_version_id: version.id,
        status: "succeeded" as const,
        request_source: "api",
        execution_mode: "prod" as const,
        started_at,
        finished_at: started_at,
      })),
    )
    .returning();
  firstRunId = runs[0]?.id ?? "";
  secondRunId = runs[1]?.id ?? "";

  await db.insert(llmUsage).values([
    usage({ conversationId, cacheRead: 50_000 }),
    usage({ conversationId, at: DAY_TWO, prompt: 300_000 }),
    usage({ conversationId: untitledConversationId, result: "error", completion: 2_000 }),
    usage({ flow: "workflow_step", executionId: firstRunId }),
    usage({ flow: "workflow_step", executionId: secondRunId, prompt: 400_000, at: DAY_TWO }),
    usage({
      flow: "workflow_step",
      executionId: secondRunId,
      result: "context_too_large",
      prompt: 0,
      at: DAY_TWO,
    }),
    usage({ tenantId: other.id, conversationId: otherTenantConversationId, prompt: 900_000 }),
  ]);

  statsOnlyKey = await issueKey(["stats:read"]);
  noConversationReadKey = await issueKey(["stats:read", "stats:read:all"]);
});

afterAll(async () => {
  await srv?.cleanup();
});

describe("LLM breakdown by conversation", () => {
  test("names each readable conversation and keeps other tenants out", async () => {
    const res = await get(`/v1/stats/llm?${WIN}&group_by=conversation`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { groups: Group[] };
    const byId = new Map(body.groups.map((g) => [g.key.conversation, g]));
    expect(byId.get(conversationId)?.conversation?.title).toBe("Wochenbericht zusammenfassen");
    expect(byId.get(conversationId)?.conversation?.owner_id).toBe(srv.userId);
    expect(byId.get(untitledConversationId)?.conversation?.title).toBeNull();
    expect(byId.has(otherTenantConversationId)).toBe(false);
    expect(byId.get(conversationId)?.cost?.amount).toBeCloseTo(0.05 + 0.005 + 0.3, 6);
    expect(byId.get("")?.totals.calls).toBe(3);
  });

  test("is a cross-user breakdown that needs stats:read:all", async () => {
    const res = await get(`/v1/stats/llm?${WIN}&group_by=conversation`, statsOnlyKey);
    expect(res.status).toBe(403);
    const own = await get(
      `/v1/stats/llm?${WIN}&group_by=conversation&user_id=${srv.userId}`,
      statsOnlyKey,
    );
    expect(own.status).toBe(200);
  });

  test("leaves titles out without conversation:read", async () => {
    const res = await get(`/v1/stats/llm?${WIN}&group_by=conversation`, noConversationReadKey);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { groups: Group[] };
    expect(body.groups.length).toBeGreaterThan(0);
    expect(body.groups.every((g) => g.conversation === undefined)).toBe(true);
  });
});

describe("LLM failed calls", () => {
  test("a result filter keeps only failed calls, with their reasons and cost", async () => {
    const res = await get(
      `/v1/stats/llm?${WIN}&group_by=workflow&result=error,context_too_large,quota_exhausted`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      groups: Group[];
      totals: { calls: { total: number; by_result: Record<string, number> } };
      cost: { amount: number };
    };
    expect(body.totals.calls.total).toBe(2);
    expect(body.totals.calls.by_result).toEqual({ error: 1, context_too_large: 1 });
    const workflow = body.groups.find((g) => g.key.workflow === workflowId);
    expect(workflow?.totals.result).toEqual({ context_too_large: 1 });
    expect(workflow?.cost?.amount).toBe(0);
    expect(body.cost.amount).toBeCloseTo(0.1 + 0.01, 6);
  });

  test("an unknown result is refused", async () => {
    const res = await get(`/v1/stats/llm?${WIN}&result=broken`);
    expect(res.status).toBe(400);
  });
});

describe("LLM cost per day, run and model", () => {
  test("each day carries its cost and the days add up to the group", async () => {
    const res = await get(`/v1/stats/llm?${WIN}&group_by=flow`);
    const body = (await res.json()) as { groups: Group[] };
    for (const group of body.groups) {
      const days = group.buckets.reduce((sum, b) => sum + (b.cost?.amount ?? 0), 0);
      expect(days).toBeCloseTo(group.cost?.amount ?? 0, 6);
    }
    const runs = body.groups.find((g) => g.key.flow === "workflow_step");
    const day = (ts: string) => runs?.buckets.find((b) => b.ts === ts)?.cost?.amount;
    expect(day("2026-02-02T00:00:00.000Z")).toBeCloseTo(0.1, 6);
    expect(day("2026-02-03T00:00:00.000Z")).toBeCloseTo(0.4, 6);
  });

  test("runs of one workflow are priced one by one", async () => {
    const res = await get(`/v1/stats/llm?${WIN}&group_by=execution&workflow_id=${workflowId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { groups: Group[]; totals: { calls: { total: number } } };
    expect(body.totals.calls.total).toBe(3);
    const cost = new Map(body.groups.map((g) => [g.key.execution, g.cost?.amount]));
    expect(cost.get(firstRunId)).toBeCloseTo(0.1, 6);
    expect(cost.get(secondRunId)).toBeCloseTo(0.4, 6);
  });

  test("a model group carries its effective price and the window its cache savings", async () => {
    const res = await get(`/v1/stats/llm?${WIN}&group_by=model`);
    const body = (await res.json()) as { groups: Group[]; cost: { cache_savings: number } };
    const haiku = body.groups.find((g) => g.key.model === "claude-haiku-4-5");
    expect(haiku?.model_price?.input_per_mtok).toBe(1);
    expect(haiku?.model_price?.output_per_mtok).toBe(5);
    expect(haiku?.model_price?.cache_read_per_mtok).toBe(0.1);
    expect(body.cost.cache_savings).toBeCloseTo(0.05 * 0.9, 6);
  });
});
