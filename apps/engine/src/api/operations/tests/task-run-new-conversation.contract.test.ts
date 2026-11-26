import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createElicitation } from "../../../conversations/elicitations.ts";
import { cancelConversation } from "../../../conversations/service/lifecycle.ts";
import { users } from "../../../db/schema/index.ts";
import {
  browserSessionHeaders,
  createHttpTestServer,
  type HttpTestServer,
} from "../../../http/tests/setup.ts";
import { builtinRoleId } from "../../../rbac/roles.ts";
import { defaultTaskServiceDeps, TaskRunSchema } from "../../../tasks/index.ts";
import { taskBody } from "./task-golden-world.ts";

let ctx: HttpTestServer;
let owner: Record<string, string>;
let other: Record<string, string>;
let admin: Record<string, string>;
let adminKey: Record<string, string>;
const enqueued: string[] = [];
const wiredEnqueue = defaultTaskServiceDeps.enqueueRunTurn;

async function call(path: string, headers: Record<string, string>, body?: unknown) {
  const response = await fetch(`${ctx.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : null) as Record<string, unknown>,
  };
}

async function member(email: string): Promise<string> {
  const [row] = await ctx.db
    .insert(users)
    .values({ tenant_id: ctx.tenantId, email, role_id: await builtinRoleId(ctx.db, "member") })
    .returning({ id: users.id });
  if (!row) throw new Error("missing member fixture");
  return row.id;
}

async function heldRun(): Promise<{ id: string; conversation_id: string }> {
  const task = await call("/v1/tasks", owner, taskBody({ name: "Weekly report" }));
  expect(task.status).toBe(201);
  const started = await call(`/v1/tasks/${task.body.id as string}/runs`, owner);
  expect(started.status).toBe(201);
  const run = {
    id: started.body.id as string,
    conversation_id: started.body.conversation_id as string,
  };
  await cancelConversation(ctx.tenantId, run.conversation_id, null, ctx.db, "system");
  const opening = await createElicitation(
    {
      tenant_id: ctx.tenantId,
      conversation_id: run.conversation_id,
      tool_call_id: null,
      tool_name: "ask_user_text",
      summary: "Which report?",
      input: { question: "Which report should I send?" },
      actor_id: null,
      actor_type: "system",
    },
    ctx.db,
  );
  expect(opening.ok).toBe(false);
  return run;
}

const path = (id: string) => `/v1/task-runs/${id}/new-conversation`;

beforeAll(async () => {
  ctx = await createHttpTestServer("task_run_new_conversation_contract");
  defaultTaskServiceDeps.enqueueRunTurn = async (_db, params) => {
    enqueued.push(params.task_run_id);
  };
  owner = await browserSessionHeaders(ctx, await member("owner-new-conversation@test.local"));
  other = await browserSessionHeaders(ctx, await member("other-new-conversation@test.local"));
  admin = await browserSessionHeaders(ctx, ctx.userId);
  adminKey = { authorization: `Bearer ${ctx.apiKey}` };
}, 120_000);

afterAll(async () => {
  defaultTaskServiceDeps.enqueueRunTurn = wiredEnqueue;
  await ctx?.cleanup();
});

describe("POST /v1/task-runs/{id}/new-conversation contract", () => {
  test("the owner gets the run back running in a new conversation, and its next turn is queued", async () => {
    const run = await heldRun();

    const moved = await call(path(run.id), owner);

    expect(moved.status).toBe(200);
    const body = TaskRunSchema.parse(moved.body);
    expect(body).toMatchObject({ id: run.id, state: "running", waiting_reason: null });
    expect(body.conversation_id).not.toBeNull();
    expect(body.conversation_id).not.toBe(run.conversation_id);
    expect(enqueued).toContain(run.id);
  });

  test("a refusal is a value with a code that names the reason", async () => {
    const run = await heldRun();

    expect(await call(path(run.id), admin)).toMatchObject({
      status: 403,
      body: { code: "task_run_owner_only" },
    });
    expect(await call(path(run.id), adminKey)).toMatchObject({
      status: 403,
      body: { code: "human_session_required" },
    });
    expect(await call(path(run.id), other)).toMatchObject({
      status: 404,
      body: { code: "task_run_not_found" },
    });

    expect((await call(path(run.id), owner)).status).toBe(200);
    expect(await call(path(run.id), owner)).toMatchObject({
      status: 409,
      body: { code: "task_run_not_held" },
    });
  });

  test("the operation is part of the published OpenAPI document", async () => {
    const response = await fetch(`${ctx.baseUrl}/openapi.json`);
    const spec = (await response.json()) as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    const operation = spec.paths["/v1/task-runs/{id}/new-conversation"]?.post;
    expect(Object.keys(operation?.responses ?? {})).toEqual(
      expect.arrayContaining(["200", "403", "404", "409"]),
    );
  });
});
