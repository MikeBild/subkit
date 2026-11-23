import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, desc, eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { AuditAction } from "../../audit/index.ts";
import { flushOidcBearerKeys } from "../../auth/providers/oidc-bearer.ts";
import { loadConfig } from "../../config/loader.ts";
import {
  auditLog,
  callerBudgetUnits,
  connectors,
  executions,
  workflowExecutionAuthorities,
} from "../../db/schema/index.ts";
import { createWorkflowRow } from "../../execution/tests/setup.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import {
  BEARER_NOW_SECONDS,
  startTestBearerIssuer,
  type TestBearerIssuer,
} from "../../test-helpers/oidc-bearer-issuer.ts";
import { previewWorkflowAuthority } from "../../workflows/execution-authorities.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;
let issuer: TestBearerIssuer;
let assistantId: string;
const sent: unknown[] = [];
const nextUuid = createDeterministicUuidFactory(331);

const fakeBoss = {
  send: async (_queue: string, job: unknown) => {
    sent.push(job);
    return "queued";
  },
} as unknown as PgBoss;

function token(sub: string) {
  return issuer.mint({ sub }, { issuedAt: BEARER_NOW_SECONDS, expiresIn: 10 * 365 * 24 * 3600 });
}

async function call(path: string, bearer: string | null, init: RequestInit = {}) {
  return fetch(`${ctx.baseUrl}${path}`, {
    ...init,
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

let sequence = 0;

function run(
  bearer: string,
  input: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  sequence += 1;
  return call("/v1/executions", bearer, {
    method: "POST",
    headers,
    body: JSON.stringify({
      workflow_id: assistantId,
      async: true,
      idempotency_key: `${input.turn_id}:${sequence}`,
      input: { purpose: "round", ...input },
      ...extra,
    }),
  });
}

function rerun(bearer: string, execution_id: string, input: Record<string, unknown>) {
  return call(`/v1/executions/${execution_id}/rerun`, bearer, {
    method: "POST",
    body: JSON.stringify({ input: { purpose: "round", ...input } }),
  });
}

async function appRefusalsToday(): Promise<number> {
  const res = await call("/v1/apps/testapp", ctx.apiKey);
  expect(res.status).toBe(200);
  const view = (await res.json()) as { budget_today: { refusals_today: number } };
  return view.budget_today.refusals_today;
}

async function loadProductConfig(assistant: string) {
  const dir = mkdtempSync(join(tmpdir(), "subkit-product-config-"));
  const file = join(dir, "subkit.config.json");
  await writeFile(
    file,
    JSON.stringify({
      auth: {
        providers: [
          { protocol: "api_key", id: "api-key", label: "SubKit API key" },
          issuer.provider({ tenant_slug: "t-product-bearer-budget" }),
        ],
        enable_signup: false,
      },
      products: {
        testapp: {
          execution_environment: "prod",
          assistant_workflow_id: assistant,
          budget_bucket: "brain",
        },
      },
    }),
  );
  await loadConfig({
    env: { DATABASE_URL: ctx.testDb.url, NODE_ENV: "test" },
    configPathOverride: file,
  });
}

async function authorize(workflow_id: string, workflow_version_id: string) {
  const preview = await previewWorkflowAuthority(
    { tenant_id: ctx.tenantId, workflow_id, workflow_version_id, execution_environment: "prod" },
    ctx.db,
  );
  await ctx.db.insert(workflowExecutionAuthorities).values({
    tenant_id: ctx.tenantId,
    workflow_id,
    workflow_version_id,
    effect_manifest_digest: preview.digest,
    effect_manifest: { ...preview.manifest },
    target_constraints: { targets: [] },
    execution_environment: "prod",
    valid_from: new Date(getTestNow() - 60_000),
    created_by: ctx.userId,
  });
}

beforeAll(async () => {
  ctx = await createHttpTestServer("product-bearer-budget", { appOptions: { boss: fakeBoss } });
  issuer = await startTestBearerIssuer();
  const created = await createWorkflowRow(ctx, {
    name: "te-kit-brain-round",
    product_id: "testapp",
    required_caller_kind: "user",
    execution_privacy: "sensitive",
    input_schema: {
      type: "object",
      required: ["turn_id", "purpose"],
      properties: {
        turn_id: { type: "string" },
        purpose: { enum: ["round", "classify"] },
        final: { type: "boolean" },
        padding: { type: "string" },
      },
    },
    steps: [
      {
        id: "round",
        kind: "transform",
        expression:
          "return { output: [{ type: input.input.final ? 'message' : 'function_call', id: 'item-1' }], model_usage: { input_tokens: 3 } };",
      },
    ],
    execution_guards: {
      caller_daily_limit: {
        bucket: "brain",
        limit: 2,
        tz: "Europe/Berlin",
        unit: "turn_id",
        billable_steps: ["round"],
        max_metered: 13,
        commit_when: "true",
      },
    },
  });
  assistantId = created.workflow_id;
  await authorize(created.workflow_id, created.version_id);
}, 60_000);

afterAll(async () => {
  await issuer?.stop();
  if (ctx) await ctx.cleanup();
}, 60_000);

beforeEach(async () => {
  flushOidcBearerKeys();
  await loadProductConfig(assistantId);
});

describe("te-brain compatible budget over HTTP", () => {
  test("a fresh caller sees an untouched allowance", async () => {
    const res = await call("/v1/budget", await token(nextUuid()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ usedToday: 0, dailyLimit: 2 });
    expect(typeof body.day).toBe("string");
    expect(typeof body.resetsAt).toBe("string");
  });

  test("without a live authority a product run is refused, never held, and charges nothing", async () => {
    const unapproved = await createWorkflowRow(ctx, {
      name: "unapproved brain round",
      product_id: "testapp",
      required_caller_kind: "user",
      execution_privacy: "sensitive",
      steps: [{ id: "round", kind: "transform", expression: "return { output: [] };" }],
      execution_guards: {
        caller_daily_limit: {
          bucket: "brain",
          limit: 2,
          tz: "Europe/Berlin",
          unit: "turn_id",
          billable_steps: ["round"],
          max_metered: 13,
          commit_when: "true",
        },
      },
    });
    const bearer = await token(nextUuid());
    const refused = await run(
      bearer,
      { turn_id: "unapproved" },
      { workflow_id: unapproved.workflow_id },
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "execution_authority_required" });
    const held = await run(bearer, { turn_id: "held" }, { hold_writes: true });
    expect(held.status).toBe(403);
    expect(await held.json()).toMatchObject({ code: "product_preparation_forbidden" });
    const rows = await ctx.db
      .select({ id: executions.id })
      .from(executions)
      .where(
        and(
          eq(executions.tenant_id, ctx.tenantId),
          eq(executions.workflow_id, unapproved.workflow_id),
        ),
      );
    expect(rows).toEqual([]);
    const units = await ctx.db
      .select({ key: callerBudgetUnits.unit_key })
      .from(callerBudgetUnits)
      .where(eq(callerBudgetUnits.tenant_id, ctx.tenantId));
    expect(units.map((unit) => unit.key)).not.toContain("unapproved");
    expect(units.map((unit) => unit.key)).not.toContain("held");
  });

  test("an environment header cannot move a product run out of the product environment", async () => {
    const bearer = await token(nextUuid());
    const res = await run(bearer, { turn_id: "env-turn" }, {}, { "x-subkit-environment": "dev" });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { execution_id: string };
    const [row] = await ctx.db
      .select({ mode: executions.execution_mode })
      .from(executions)
      .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, body.execution_id)));
    expect(row).toEqual({ mode: "prod" });
  });

  test("an async run defaults to the product environment and is accepted with 202", async () => {
    const bearer = await token(nextUuid());
    const res = await run(bearer, { turn_id: "async-turn" });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { execution_id: string; status: string };
    expect(body.status).toBe("queued");
    const [row] = await ctx.db
      .select({ mode: executions.execution_mode, guard: executions.guard_bucket })
      .from(executions)
      .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, body.execution_id)));
    expect(row).toEqual({ mode: "prod", guard: "brain" });
    const cancel = await call(`/v1/executions/${body.execution_id}/cancel`, bearer, {
      method: "POST",
      body: "{}",
    });
    expect([200, 202]).toContain(cancel.status);
    const budget = (await (await call("/v1/budget", bearer)).json()) as { usedToday: number };
    expect(budget.usedToday).toBe(0);
  });

  test("a call while the previous call of the turn is queued answers 409 turn-busy", async () => {
    const bearer = await token(nextUuid());
    expect((await run(bearer, { turn_id: "busy-turn" })).status).toBe(202);
    const busy = await run(bearer, { turn_id: "busy-turn" });
    expect(busy.status).toBe(409);
    const body = (await busy.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ error: "turn-busy", code: "turn_busy" });
    expect(body).not.toHaveProperty("execution_id");
  });

  test("after turn-busy the same key is admitted once the earlier call stops", async () => {
    const bearer = await token(nextUuid());
    const first = await run(
      bearer,
      { turn_id: "replay-turn" },
      { idempotency_key: "replay-turn:1" },
    );
    expect(first.status).toBe(202);
    const { execution_id: firstId } = (await first.json()) as { execution_id: string };
    const second = { idempotency_key: "replay-turn:2" };
    expect((await run(bearer, { turn_id: "replay-turn" }, second)).status).toBe(409);
    const replay = await run(
      bearer,
      { turn_id: "replay-turn" },
      { idempotency_key: "replay-turn:1" },
    );
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({ execution_id: firstId, idempotent_replay: true });
    expect((await run(bearer, { turn_id: "replay-turn" }, second)).status).toBe(409);
    const cancel = await call(`/v1/executions/${firstId}/cancel`, bearer, {
      method: "POST",
      body: "{}",
    });
    expect([200, 202]).toContain(cancel.status);
    const admitted = await run(bearer, { turn_id: "replay-turn" }, second);
    expect(admitted.status).toBe(202);
    const admittedBody = (await admitted.json()) as { execution_id: string };
    expect(admittedBody.execution_id).not.toBe(firstId);
    const budget = (await (await call("/v1/budget", bearer)).json()) as { usedToday: number };
    expect(budget.usedToday).toBe(1);
  });

  test("a finished turn returns its result with usage, and the third turn is rate limited", async () => {
    const bearer = await token(nextUuid());
    const first = await run(bearer, { turn_id: "turn-1", final: true }, { async: false });
    expect(first.status).toBe(200);
    const { execution_id } = (await first.json()) as { execution_id: string };
    const polled = (await (await call(`/v1/executions/${execution_id}`, bearer)).json()) as Record<
      string,
      unknown
    >;
    expect(polled).toMatchObject({ execution_id, status: "succeeded", error: null });
    const result = await call(`/v1/executions/${execution_id}/result`, bearer);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({
      result: {
        output: [{ type: "message", id: "item-1" }],
        model_usage: { input_tokens: 3 },
        usage: { usedToday: 1, dailyLimit: 2 },
      },
    });
    expect((await run(bearer, { turn_id: "turn-2" })).status).toBe(202);
    const refused = await run(bearer, { turn_id: "turn-3" });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({
      error: "rate-limited",
      code: "rate_limited",
      message: "the daily limit is reached",
      usage: { usedToday: 2, dailyLimit: 2 },
    });
    const later = await run(bearer, { turn_id: "turn-1" });
    expect(later.status).toBe(202);
    const budget = (await (await call("/v1/budget", bearer)).json()) as { usedToday: number };
    expect(budget.usedToday).toBe(2);
  });

  test("a rerun past the daily limit answers 429 and is counted as a refusal of the app", async () => {
    const bearer = await token(nextUuid());
    const first = await run(bearer, { turn_id: "rerun-1", final: true }, { async: false });
    expect(first.status).toBe(200);
    const { execution_id } = (await first.json()) as { execution_id: string };
    expect((await run(bearer, { turn_id: "rerun-2" })).status).toBe(202);
    const refusalsBefore = await appRefusalsToday();
    const refused = await rerun(bearer, execution_id, { turn_id: "rerun-3" });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({
      error: "rate-limited",
      code: "rate_limited",
      message: "the daily limit is reached",
      usage: { usedToday: 2, dailyLimit: 2 },
    });
    const [audit] = await ctx.db
      .select({ reason: auditLog.reason, metadata: auditLog.metadata })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.action, AuditAction.EXECUTION_BOUNDARY_REFUSED),
          sql`${auditLog.metadata}->>'rerun_of' = ${execution_id}`,
        ),
      )
      .orderBy(desc(auditLog.ts))
      .limit(1);
    expect(audit?.reason).toBe("rate_limited");
    expect(audit?.metadata).toMatchObject({ workflow_id: assistantId, rerun_of: execution_id });
    expect(await appRefusalsToday()).toBe(refusalsBefore + 1);
  });

  test("a rerun into a turn whose call is still queued answers 409 turn-busy", async () => {
    const bearer = await token(nextUuid());
    const first = await run(bearer, { turn_id: "rerun-busy-1", final: true }, { async: false });
    expect(first.status).toBe(200);
    const { execution_id } = (await first.json()) as { execution_id: string };
    expect((await run(bearer, { turn_id: "rerun-busy-2" })).status).toBe(202);
    const busy = await rerun(bearer, execution_id, { turn_id: "rerun-busy-2" });
    expect(busy.status).toBe(409);
    const body = (await busy.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ error: "turn-busy", code: "turn_busy" });
    expect(body).not.toHaveProperty("execution_id");
  });

  test("an input outside the schema is refused with 400 before any charge", async () => {
    const bearer = await token(nextUuid());
    const res = await run(bearer, { turn_id: "bad" }, { input: { purpose: "round" } });
    expect(res.status).toBe(400);
    const budget = (await (await call("/v1/budget", bearer)).json()) as { usedToday: number };
    expect(budget.usedToday).toBe(0);
  });

  test("a body of 256 KiB is accepted", async () => {
    const bearer = await token(nextUuid());
    const res = await run(bearer, { turn_id: "large", padding: "x".repeat(262_144) });
    expect(res.status).toBe(202);
  });

  test("another caller cannot read a caller's execution or result", async () => {
    const owner = await token(nextUuid());
    const intruder = await token(nextUuid());
    const res = await run(owner, { turn_id: "own", final: true }, { async: false });
    const { execution_id } = (await res.json()) as { execution_id: string };
    expect((await call(`/v1/executions/${execution_id}`, intruder)).status).toBe(404);
    expect((await call(`/v1/executions/${execution_id}/result`, intruder)).status).toBe(404);
    const list = (await (await call("/v1/executions", intruder)).json()) as {
      items?: Array<{ id: string }>;
      data?: Array<{ id: string }>;
    };
    expect((list.items ?? list.data ?? []).map((row) => row.id)).not.toContain(execution_id);
  });

  test("health is ok with an active workflow, a live authority and no missing credential", async () => {
    const res = await call("/v1/health", await token(nextUuid()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      version: "1",
      model: { id: null, status: "unchecked" },
      key: "present",
    });
  });

  test("health reports a missing connector credential and never a secret", async () => {
    const [connector] = await ctx.db
      .insert(connectors)
      .values({
        tenant_id: ctx.tenantId,
        slug: "openai-missing",
        display_name: "OpenAI",
        driver: "http",
        environment: "prod",
        auth_type: "bearer",
        base_url: "https://api.example.test",
      })
      .returning({ id: connectors.id });
    if (!connector) throw new Error("connector fixture missing");
    const gated = await createWorkflowRow(ctx, {
      name: "gate with missing key",
      product_id: "testapp",
      required_caller_kind: "user",
      execution_privacy: "sensitive",
      steps: [
        {
          id: "round",
          kind: "request",
          connector_id: connector.id,
          method: "POST",
          path: "/v1/responses",
          side_effects: "write",
        },
      ],
    });
    await loadProductConfig(gated.workflow_id);
    const res = await call("/v1/health", await token(nextUuid()));
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      ok: false,
      version: "1",
      model: { id: null, status: "unchecked" },
      key: "missing",
    });
  });

  test("product routes answer 404 to a non-product principal and 401 without credentials", async () => {
    expect((await call("/v1/budget", ctx.apiKey)).status).toBe(404);
    expect((await call("/v1/health", ctx.apiKey)).status).toBe(404);
    expect((await call("/v1/budget", null)).status).toBe(401);
  });
});
