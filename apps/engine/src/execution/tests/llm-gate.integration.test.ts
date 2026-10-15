import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { IncomingMessage } from "node:http";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { upsertCredential } from "../../credentials/service.ts";
import {
  callerBudgetUnits,
  connectors,
  executions,
  userIdentities,
  users,
  workflowExecutionAuthorities,
} from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { databaseNow } from "../../test-helpers/database-clock.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { previewWorkflowAuthority } from "../../workflows/execution-authorities.ts";
import { admitAuthorizedWorkflowExecution } from "../authority-admission.ts";
import { authorizationContextFromPrincipal } from "../authorization-context.ts";
import { callerFromPrincipal } from "../caller-context.ts";
import { runExecution } from "../engine.ts";
import { recoverExecutionPayload } from "../sensitive-payload.ts";
import {
  createEngineCtx,
  createMockServer,
  createWorkflowRow,
  type EngineTestCtx,
  jsonResponse,
  type MockServer,
} from "./setup.ts";

let ctx: EngineTestCtx;
let model: MockServer;
let workflowId: string;
let received: Array<{ headers: IncomingMessage["headers"]; body: Record<string, unknown> }> = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };
const nextUuid = createDeterministicUuidFactory(0x6a7e);

const TOOL = {
  type: "function",
  name: "show",
  description: "Show a chord",
  parameters: { type: "object", properties: { chord: { type: "string" } } },
  strict: false,
};

function gateDefinition(connectorId: string) {
  return {
    name: "llm gate",
    slug: "llm-gate",
    product_id: "tekit",
    required_caller_kind: "user",
    execution_privacy: "sensitive",
    timeout_ms: 30000,
    input_schema: {
      type: "object",
      required: ["turn_id", "round", "request"],
      properties: {
        turn_id: { type: "string" },
        round: { type: "integer", minimum: 1, maximum: 6 },
        request: {
          type: "object",
          required: ["instructions", "input", "tools", "tool_choice"],
          properties: {
            tools: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  type: { const: "function" },
                  name: { enum: ["show"] },
                  description: { type: "string" },
                  parameters: { type: "object" },
                  strict: { type: "boolean" },
                },
              },
            },
            tool_choice: { enum: ["auto", "none"] },
          },
        },
      },
    },
    execution_guards: {
      input_bytes: { "request.instructions": 64 },
      caller_daily_limit: {
        bucket: "brain",
        limit: 50,
        tz: "Europe/Berlin",
        unit: "turn_id",
        round: "round",
        billable_steps: ["respond"],
        max_metered: 13,
        commit_when: "$count(output[type = 'function_call']) = 0",
      },
    },
    steps: [
      {
        id: "respond",
        kind: "request",
        connector_id: connectorId,
        method: "POST",
        path: "/v1/responses",
        side_effects: "write",
        timeout_ms: 30000,
        body: {
          model: "gpt-5.6-terra",
          store: false,
          max_output_tokens: 4096,
          // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
          instructions: "${input.request.instructions}",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
          input: "${input.request.input}",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
          tools: "${input.request.tools}",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
          tool_choice: "${input.request.tool_choice}",
        },
        boundary: { variables: {}, max_body_bytes: 400000, max_calls: 1 },
      },
    ],
    output_transform:
      '{ "status": $scope.respond.data.status, "output": $scope.respond.data.output[], "model_usage": $scope.respond.data.usage }',
  };
}

async function productUser(): Promise<ResolvedPrincipal> {
  const subject = nextUuid();
  const [user] = await ctx.testDb.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: `tekit-supabase:${subject}@invalid`,
      role_id: await builtinRoleId(ctx.testDb.db, "member"),
    })
    .returning({ id: users.id });
  if (!user) throw new Error("user fixture missing");
  const [identity] = await ctx.testDb.db
    .insert(userIdentities)
    .values({
      tenant_id: ctx.tenantId,
      user_id: user.id,
      provider_id: "tekit-supabase",
      issuer_url: "https://auth.example.test/auth/v1",
      product_id: "tekit",
      subject,
      email: `tekit-supabase:${subject}@invalid`,
    })
    .returning({ id: userIdentities.id });
  if (!identity) throw new Error("identity fixture missing");
  return {
    provider: "tekit-supabase",
    kind: "user",
    id: user.id,
    tenant_id: ctx.tenantId,
    product_id: "tekit",
    roles: ["member"],
    subject,
    auth_source: {
      kind: "external_bearer",
      provider_id: "tekit-supabase",
      identity_id: identity.id,
      issued_at: new Date(getTestNow()).toISOString(),
      expires_at: new Date(getTestNow() + 3_600_000).toISOString(),
    },
  };
}

function request(extra: Record<string, unknown> = {}) {
  return {
    instructions: "Answer briefly.",
    input: [{ role: "user", content: [{ type: "input_text", text: "Which chord follows G7?" }] }],
    tools: [TOOL],
    tool_choice: "auto",
    model: "client-chosen",
    store: true,
    metadata: { client: "x" },
    previous_response_id: "resp_client",
    user: "someone",
    safety_identifier: "client-safety",
    ...extra,
  };
}

async function turn(principal: ResolvedPrincipal, input: Record<string, unknown>) {
  const admitted = await admitAuthorizedWorkflowExecution(
    {
      tenant_id: ctx.tenantId,
      workflow_id: workflowId,
      execution_environment: "dev",
      request_source: "api",
      input,
    },
    ctx.testDb.db,
    callerFromPrincipal(principal, ctx.tenantId, "tekit", "user"),
    authorizationContextFromPrincipal(principal),
  );
  const result = await runExecution({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    source: { kind: "saved", workflow_id: workflowId },
    input: admitted.input,
    options: { existing_execution_id: admitted.execution_id, principal },
  });
  return { execution_id: admitted.execution_id, result };
}

async function storedResult(execution_id: string) {
  const [row] = await ctx.testDb.db
    .select({ sensitive_result: executions.sensitive_result, failure: executions.failure })
    .from(executions)
    .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, execution_id)));
  return {
    result: recoverExecutionPayload(row?.sensitive_result, ctx.tenantId, execution_id, "result"),
    failure: row?.failure,
  };
}

async function unit(principal: ResolvedPrincipal, turn_id: string) {
  const [row] = await ctx.testDb.db
    .select()
    .from(callerBudgetUnits)
    .where(
      and(
        eq(callerBudgetUnits.tenant_id, ctx.tenantId),
        eq(callerBudgetUnits.principal_id, principal.id),
        eq(callerBudgetUnits.unit_key, turn_id),
      ),
    );
  return row;
}

beforeAll(async () => {
  ctx = await createEngineCtx("llm-gate");
  model = await createMockServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    received.push({
      headers: req.headers,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
    });
    jsonResponse(res, reply.status, reply.body);
  });
  const db = ctx.testDb.db;
  const [connector] = await db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug: "openai",
      display_name: "OpenAI",
      driver: "http",
      auth_type: "bearer",
      environment: "dev",
      base_url: model.baseUrl,
    })
    .returning();
  if (!connector) throw new Error("connector fixture missing");
  await upsertCredential(
    {
      tenant_id: ctx.tenantId,
      connector_id: connector.id,
      environment: "dev",
      mode: "bearer",
      actor_id: null,
      value: { mode: "bearer", token: "fixture-model-key" },
    },
    db,
  );
  const workflow = await createWorkflowRow(ctx, gateDefinition(connector.id));
  workflowId = workflow.workflow_id;
  const preview = await previewWorkflowAuthority(
    {
      tenant_id: ctx.tenantId,
      workflow_id: workflow.workflow_id,
      workflow_version_id: workflow.version_id,
      execution_environment: "dev",
    },
    db,
  );
  expect(preview.eligible_for_repeated_runs).toBe(true);
  const now = await databaseNow(db);
  await db.insert(workflowExecutionAuthorities).values({
    tenant_id: ctx.tenantId,
    workflow_id: workflow.workflow_id,
    workflow_version_id: workflow.version_id,
    effect_manifest_digest: preview.digest,
    effect_manifest: { ...preview.manifest },
    target_constraints: {
      targets: preview.manifest.effects.flatMap((effect) => (effect.target ? [effect.target] : [])),
    },
    execution_environment: "dev",
    valid_from: new Date(now.getTime() - 60_000),
    created_by: "00000000-0000-4000-8000-000000000001",
  });
});

afterAll(async () => {
  await model?.close();
  if (ctx) await ctx.cleanup();
});

beforeEach(() => {
  received = [];
  reply = {
    status: 200,
    body: {
      id: "resp_1",
      status: "completed",
      output: [{ type: "message", id: "msg_1", content: [{ type: "output_text", text: "C" }] }],
      usage: { input_tokens: 12, output_tokens: 3 },
    },
  };
});

describe("thin LLM gate under a product caller", () => {
  test("the server sets model, store and token cap and drops client-only fields", async () => {
    const principal = await productUser();
    const { result } = await turn(principal, { turn_id: "t-final", round: 1, request: request() });
    expect(result.status).toBe("succeeded");
    expect(received).toHaveLength(1);
    const sent = received[0];
    expect(sent?.headers.authorization).toBe("Bearer fixture-model-key");
    expect(sent?.body).toEqual({
      model: "gpt-5.6-terra",
      store: false,
      max_output_tokens: 4096,
      instructions: "Answer briefly.",
      input: [{ role: "user", content: [{ type: "input_text", text: "Which chord follows G7?" }] }],
      tools: [TOOL],
      tool_choice: "auto",
    });
  });

  test("a final answer commits the turn and returns items, model usage and budget usage", async () => {
    const principal = await productUser();
    const { execution_id } = await turn(principal, {
      turn_id: "t-commit",
      round: 1,
      request: request(),
    });
    expect((await storedResult(execution_id)).result).toEqual({
      status: "completed",
      output: [{ type: "message", id: "msg_1", content: [{ type: "output_text", text: "C" }] }],
      model_usage: { input_tokens: 12, output_tokens: 3 },
      usage: { usedToday: 1, dailyLimit: 50 },
    });
    expect(await unit(principal, "t-commit")).toMatchObject({
      state: "committed",
      billable: true,
      metered: 1,
    });
  });

  test("a tool call keeps the turn open and the next round costs nothing", async () => {
    const principal = await productUser();
    reply.body = {
      status: "completed",
      output: [{ type: "function_call", call_id: "call_1", name: "show", arguments: "{}" }],
      usage: { input_tokens: 5, output_tokens: 1 },
    };
    await turn(principal, { turn_id: "t-tools", round: 1, request: request() });
    expect(await unit(principal, "t-tools")).toMatchObject({ state: "reserved", metered: 1 });
    reply.body = { status: "completed", output: [{ type: "message" }], usage: {} };
    const { execution_id } = await turn(principal, {
      turn_id: "t-tools",
      round: 2,
      request: request(),
    });
    expect((await storedResult(execution_id)).result).toMatchObject({
      usage: { usedToday: 1, dailyLimit: 50 },
    });
    expect(await unit(principal, "t-tools")).toMatchObject({ state: "committed", metered: 2 });
  });

  test("an oversized part is refused as invalid without a model call or a charge", async () => {
    const principal = await productUser();
    await expect(
      turn(principal, {
        turn_id: "t-big",
        round: 1,
        request: request({ instructions: "x".repeat(100) }),
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(received).toHaveLength(0);
    expect(await unit(principal, "t-big")).toBeUndefined();
  });

  test("a tool outside the allow-list or a forced tool choice never reaches the model", async () => {
    const principal = await productUser();
    for (const extra of [
      { tools: [{ ...TOOL, name: "shell" }] },
      { tools: [{ type: "web_search" }] },
      { tool_choice: "required" },
    ]) {
      await expect(
        turn(principal, { turn_id: "t-tool", round: 1, request: request(extra) }),
      ).rejects.toMatchObject({ code: "input_schema_violation" });
    }
    expect(received).toHaveLength(0);
  });

  test("a model call that reached the upstream and failed stays charged and reports a safe failure", async () => {
    const principal = await productUser();
    reply = { status: 500, body: { error: { message: "upstream" } } };
    const { execution_id, result } = await turn(principal, {
      turn_id: "t-fail",
      round: 1,
      request: request(),
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("sensitive_execution_failure");
    expect((await storedResult(execution_id)).failure?.error_code).toBe(
      "sensitive_execution_failure",
    );
    expect(received).toHaveLength(1);
    expect(await unit(principal, "t-fail")).toMatchObject({
      state: "reserved",
      billable: true,
      metered: 1,
    });
  });

  test("a request its boundary refuses before sending is refunded", async () => {
    const principal = await productUser();
    const { result } = await turn(principal, {
      turn_id: "t-refused",
      round: 1,
      request: request({
        input: [{ role: "user", content: [{ type: "input_text", text: "x".repeat(450_000) }] }],
      }),
    });
    expect(result.status).toBe("failed");
    expect(received).toHaveLength(0);
    expect(await unit(principal, "t-refused")).toMatchObject({
      state: "refunded",
      billable: false,
      metered: 0,
    });
  });
});
