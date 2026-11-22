import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { apiKeys, conversations, llmUsage } from "../../db/schema/index.ts";
import { taskRuns, tasks } from "../../db/schema/tasks.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;

const FROM = "2026-02-02T00:00:00.000Z";
const TO = "2026-02-04T00:00:00.000Z";
const WIN = `bucket=day&tz=UTC&from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`;
const AT = new Date("2026-02-02T09:00:00.000Z");
const OTHER_USER = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";

let ownTask = "";
let otherTask = "";
let statsOnlyKey = "";

interface Group {
  key: Record<string, string>;
  cost?: { amount: number };
  totals: { calls: number; tokens: { total: number } };
}

async function issueKey(scopes: string[]): Promise<string> {
  const rand = randomBytes(20).toString("base64url").slice(0, 26); // allow-random: test only
  const plaintext = `wf_live_${rand}`;
  await srv.db.insert(apiKeys).values({
    tenant_id: srv.tenantId,
    user_id: srv.userId,
    prefix: plaintext.slice(0, 12),
    token_sha256: createHash("sha256").update(plaintext).digest("hex"),
    scopes,
  });
  return plaintext;
}

async function get(path: string, key = srv.apiKey): Promise<Response> {
  return fetch(`${srv.baseUrl}${path}`, { headers: { authorization: `Bearer ${key}` } });
}

async function seedTaskWithUsage(owner: string, name: string, trace: string, tokens: number) {
  const [task] = await srv.db
    .insert(tasks)
    .values({
      locale: "de",
      tenant_id: srv.tenantId,
      name,
      owner_id: owner,
      goal: "goal",
      done_when: "done",
      plan: { title: name, goal: "goal", steps: [] },
      bindings: { workflow_ids: [], connector_ids: [], skill_slugs: [], web_search: false },
      environment: "prod",
      fingerprint: "b".repeat(64),
    })
    .returning({ id: tasks.id });
  const [conversation] = await srv.db
    .insert(conversations)
    .values({ tenant_id: srv.tenantId, status: "active", owner_id: owner })
    .returning({ id: conversations.id });
  if (!task || !conversation) throw new Error("seed failed");
  await srv.db.insert(taskRuns).values({
    tenant_id: srv.tenantId,
    task_id: task.id,
    task_revision: 1,
    fingerprint: "b".repeat(64),
    conversation_id: conversation.id,
    trigger: "manual",
    state: "completed",
    deadline_at: new Date(AT.getTime() + 3_600_000),
    trace_id: trace.repeat(32),
  });
  await srv.db.insert(llmUsage).values({
    tenant_id: srv.tenantId,
    flow: "converse",
    model: "claude-haiku-4-5",
    prompt_tokens: tokens,
    completion_tokens: 0,
    total_tokens: tokens,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    latency_ms: 500,
    result: "success",
    created_at: AT,
    month_bucket: 202602,
    user_id: owner,
    actor_type: "user",
    conversation_id: conversation.id,
  });
  return task.id;
}

beforeAll(async () => {
  srv = await createHttpTestServer("stats-llm-task");
  ownTask = await seedTaskWithUsage(srv.userId, "Own task", "1", 100_000);
  otherTask = await seedTaskWithUsage(OTHER_USER, "Other task", "2", 300_000);
  statsOnlyKey = await issueKey(["stats:read"]);
});

afterAll(async () => {
  await srv?.cleanup();
});

describe("LLM breakdown by task", () => {
  test("group_by=task returns one priced group per task", async () => {
    const res = await get(`/v1/stats/llm?${WIN}&group_by=task`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { groups: Group[] };
    const byTask = new Map(body.groups.map((group) => [group.key.task, group]));
    expect([...byTask.keys()].sort()).toEqual([ownTask, otherTask].sort());
    expect(byTask.get(ownTask)?.totals.tokens.total).toBe(100_000);
    expect(byTask.get(otherTask)?.totals.tokens.total).toBe(300_000);
    expect(byTask.get(ownTask)?.cost?.amount).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toContain("Other task");
  });

  test("it is a cross-owner breakdown that needs stats:read:all", async () => {
    const res = await get(`/v1/stats/llm?${WIN}&group_by=task`, statsOnlyKey);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message).toContain("breakdown by task");
  });

  test("with the caller's own user_id it shows only the tasks the caller paid for", async () => {
    const res = await get(`/v1/stats/llm?${WIN}&group_by=task&user_id=${srv.userId}`, statsOnlyKey);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { groups: Group[] };
    expect(body.groups.map((group) => group.key.task)).toEqual([ownTask]);
  });

  test("an unknown dimension is still refused and names task as a valid one", async () => {
    const res = await get(`/v1/stats/llm?${WIN}&group_by=task_run`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain("execution, task");
  });
});
