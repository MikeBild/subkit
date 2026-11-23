import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, asc, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { _resetConfigForTests, loadConfig, setConfigKey } from "../../config/loader.ts";
import {
  auditLog,
  connectors,
  executionSteps,
  executions,
  workflowExecutionAuthorities,
  workflows,
} from "../../db/schema/index.ts";
import type { ExecutionRunJob } from "../../queue/queues.ts";
import { databaseNow } from "../../test-helpers/database-clock.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { adminPrincipal } from "../../test-helpers/principals.ts";
import { previewWorkflowAuthority } from "../../workflows/execution-authorities.ts";
import { admitAuthorizedWorkflowExecution } from "../authority-admission.ts";
import { cancelExecutionRequest, resolveUncertainWrite } from "../control-service.ts";
import { runExecution } from "../engine.ts";
import { planResume, type ResumePlan, recoverCrashedExecutions } from "../recovery.ts";
import { createExecution, finalizeStepRow, insertStepRow, markExecutionRunning } from "../state.ts";
import {
  createEngineCtx,
  createMockServer,
  createWorkflowRow,
  type EngineTestCtx,
  jsonResponse,
  type MockServer,
} from "./setup.ts";

const LEASE_MS = 60_000;

let ctx: EngineTestCtx;
let upstream: MockServer;
let configDir: string;
let connectorId: string;
const hits: string[] = [];
const sent: ExecutionRunJob[] = [];
const boss = {
  send: async (_queue: string, job: ExecutionRunJob) => {
    sent.push(job);
    return "job";
  },
} as unknown as PgBoss;

function later(): Date {
  return new Date(Date.now() + LEASE_MS * 2);
}

beforeAll(async () => {
  ctx = await createEngineCtx("crash-resume");
  configDir = mkdtempSync(join(tmpdir(), "subkit-crash-resume-"));
  _resetConfigForTests();
  await loadConfig({
    env: { NODE_ENV: "test", DATABASE_URL: ctx.testDb.url },
    configPathOverride: join(configDir, "subkit.config.json"),
  });
  await setConfigKey("egress.provider_hosts_extra", ["127.0.0.1"], { force: true });
  upstream = await createMockServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    jsonResponse(res, 200, { ok: true, path: req.url });
  });
  const [row] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug: "target",
      display_name: "target",
      driver: "http",
      auth_type: "none",
      environment: "dev",
      base_url: upstream.baseUrl,
    })
    .returning();
  if (!row) throw new Error("connector fixture missing");
  connectorId = row.id;
});

afterAll(async () => {
  await upstream?.close();
  await ctx?.cleanup();
  _resetConfigForTests();
  rmSync(configDir, { recursive: true, force: true });
});

beforeEach(() => {
  hits.length = 0;
  sent.length = 0;
});

async function workflow(slug: string, steps: unknown[]): Promise<string> {
  const created = await createWorkflowRow(ctx, { name: slug, slug, steps });
  const preview = await previewWorkflowAuthority(
    {
      tenant_id: ctx.tenantId,
      workflow_id: created.workflow_id,
      workflow_version_id: created.version_id,
      execution_environment: "dev",
    },
    ctx.testDb.db,
  );
  const at = await databaseNow(ctx.testDb.db);
  await ctx.testDb.db.insert(workflowExecutionAuthorities).values({
    tenant_id: ctx.tenantId,
    workflow_id: created.workflow_id,
    workflow_version_id: created.version_id,
    effect_manifest_digest: preview.digest,
    effect_manifest: { ...preview.manifest },
    target_constraints: {
      targets: preview.manifest.effects.flatMap((effect) => (effect.target ? [effect.target] : [])),
    },
    execution_environment: "dev",
    valid_from: new Date(at.getTime() - 60_000),
    created_by: "00000000-0000-4000-8000-000000000001",
  });
  return created.workflow_id;
}

interface Admitted {
  execution_id: string;
  input: unknown;
  workflow_id: string;
}

async function startedRun(workflow_id: string): Promise<Admitted> {
  const admitted = await admitAuthorizedWorkflowExecution(
    {
      tenant_id: ctx.tenantId,
      workflow_id,
      execution_environment: "dev",
      request_source: "api",
      input: null,
    },
    ctx.testDb.db,
  );
  await markExecutionRunning(ctx.testDb.db, ctx.tenantId, admitted.execution_id, new Date());
  return { execution_id: admitted.execution_id, input: admitted.input, workflow_id };
}

async function leaveStep(
  run: Admitted,
  step_key: string,
  step_index: number,
  kind: string,
  left: { output: unknown } | "running" | "dispatched",
): Promise<string> {
  const id = await insertStepRow(ctx.testDb.db, {
    tenant_id: ctx.tenantId,
    execution_id: run.execution_id,
    step_key,
    step_index,
    kind,
  });
  if (left === "dispatched") {
    await ctx.testDb.db
      .update(executionSteps)
      .set({ write_dispatched_at: new Date() })
      .where(and(eq(executionSteps.tenant_id, ctx.tenantId), eq(executionSteps.id, id)));
  } else if (left !== "running") {
    await finalizeStepRow(
      ctx.testDb.db,
      id,
      "succeeded",
      { status: "succeeded", duration_ms: 1, retry_count: 0, output: left.output },
      {
        tenant_id: ctx.tenantId,
        output_preview: left.output,
        result_preview: null,
        result_storage_uri: null,
      },
    );
  }
  return id;
}

async function steps(execution_id: string) {
  return ctx.testDb.db
    .select()
    .from(executionSteps)
    .where(
      and(
        eq(executionSteps.tenant_id, ctx.tenantId),
        eq(executionSteps.execution_id, execution_id),
      ),
    )
    .orderBy(asc(executionSteps.started_at));
}

async function execution(execution_id: string) {
  const [row] = await ctx.testDb.db
    .select()
    .from(executions)
    .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, execution_id)));
  if (!row) throw new Error("execution missing");
  return row;
}

function redeliver(run: Admitted, now: Date = later()): Promise<ResumePlan> {
  return planResume(ctx.testDb.db, {
    tenant_id: ctx.tenantId,
    execution_id: run.execution_id,
    now,
    lease_ms: LEASE_MS,
  });
}

async function continueRun(run: Admitted, plan: ResumePlan) {
  if (plan.kind !== "run") throw new Error(`expected a run plan, got ${plan.kind}`);
  return runExecution({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    source: { kind: "saved", workflow_id: run.workflow_id },
    input: run.input,
    options: {
      existing_execution_id: run.execution_id,
      resume_authorized: true,
      crash_resume: plan.crash_resume,
      crash_claimed: plan.claimed,
    },
  });
}

function resolve(run: Admitted, step_key: string, outcome: "arrived" | "not_arrived") {
  return resolveUncertainWrite(ctx.testDb.db, {
    principal: adminPrincipal(ctx.tenantId),
    execution_id: run.execution_id,
    step_key,
    outcome,
    request_source: "api",
    boss,
  });
}

const READS = [
  { id: "one", kind: "transform", language: "javascript", expression: "return { n: 1 };" },
  { id: "two", kind: "request", method: "GET", path: "/second" },
  { id: "three", kind: "request", method: "GET", path: "/third" },
  {
    id: "sum",
    kind: "transform",
    language: "javascript",
    expression:
      "return { n: input.scope.one.data.n, second: input.scope.two.data.path, third: input.scope.three.data.path };",
  },
];

function withConnector(list: unknown[]): unknown[] {
  return list.map((step) =>
    (step as { kind: string }).kind === "request"
      ? { ...(step as object), connector_id: connectorId }
      : step,
  );
}

describe("a run whose engine stopped", () => {
  test("is left alone while its heartbeat is recent", async () => {
    const run = await startedRun(await workflow("resume-alive", withConnector(READS)));
    expect(await redeliver(run, new Date())).toEqual({ kind: "skip", reason: "alive" });
    expect((await execution(run.execution_id)).attempt).toBe(0);
  });

  test("continues after its second step without repeating the first two", async () => {
    const run = await startedRun(await workflow("resume-reads", withConnector(READS)));
    const first = await leaveStep(run, "one", 0, "transform", { output: { n: 1 } });
    const second = await leaveStep(run, "two", 1, "request", {
      output: { ok: true, path: "/second" },
    });
    await leaveStep(run, "three", 2, "request", "running");
    const before = await steps(run.execution_id);

    const plan = await redeliver(run);
    expect(plan.kind).toBe("run");
    expect(await redeliver(run)).toEqual({ kind: "skip", reason: "alive" });
    expect((await execution(run.execution_id)).attempt).toBe(1);

    const result = await continueRun(run, plan);
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ n: 1, second: "/second", third: "/third" });
    expect(hits).toEqual(["GET /third"]);
    const after = await steps(run.execution_id);
    expect(after.find((step) => step.id === first)).toEqual(
      before.find((step) => step.id === first),
    );
    expect(after.find((step) => step.id === second)).toEqual(
      before.find((step) => step.id === second),
    );
    expect(after.filter((step) => step.step_key === "one")).toHaveLength(1);
    expect(after.filter((step) => step.step_key === "two")).toHaveLength(1);
    expect(after.filter((step) => step.step_key === "three").map((step) => step.status)).toEqual([
      "skipped",
      "succeeded",
    ]);
  });

  test("turns uncertain when it stopped while sending a change, and sends nothing", async () => {
    const run = await startedRun(
      await workflow(
        "resume-write",
        withConnector([READS[0], { id: "send", kind: "request", method: "POST", path: "/send" }]),
      ),
    );
    await leaveStep(run, "one", 0, "transform", { output: { n: 1 } });
    await leaveStep(run, "send", 1, "request", "dispatched");

    expect(await redeliver(run)).toEqual({ kind: "settled", status: "uncertain" });
    const stopped = await execution(run.execution_id);
    expect(stopped.status).toBe("uncertain");
    expect(stopped.finished_at).toBeNull();
    expect(stopped.failure?.error_code).toBe("engine_stopped_during_write");
    expect(stopped.failure?.step_id).toBe("send");
    const rows = await steps(run.execution_id);
    expect(rows.find((step) => step.step_key === "send")?.status).toBe("uncertain");
    expect(hits).toEqual([]);
    const audits = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.action, "execution.write_uncertain"),
          eq(auditLog.resource_id, run.execution_id),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(await redeliver(run)).toEqual({ kind: "start" });
    expect((await execution(run.execution_id)).status).toBe("uncertain");

    expect(await resolve(run, "one", "arrived")).toEqual({ kind: "unknown_step" });
    expect(await resolve(run, "send", "arrived")).toEqual({
      kind: "resolved",
      status: "queued",
      remaining: [],
    });
    expect(await resolve(run, "send", "arrived")).toEqual({ kind: "not_uncertain" });
    expect(sent).toEqual([
      { tenant_id: ctx.tenantId, workflow_id: run.workflow_id, execution_id: run.execution_id },
    ]);
    expect((await execution(run.execution_id)).status).toBe("queued");

    const result = await continueRun(run, await redeliver(run));
    expect(result.status).toBe("succeeded");
    expect(hits).toEqual([]);
    const resolved = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.action, "execution.write_resolved"),
          eq(auditLog.resource_id, run.execution_id),
        ),
      );
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.metadata).toMatchObject({ step_key: "send", outcome: "arrived" });
  });

  test("sends the change once more after the answer that it did not arrive", async () => {
    const run = await startedRun(
      await workflow(
        "resume-write-missing",
        withConnector([READS[0], { id: "send", kind: "request", method: "POST", path: "/send" }]),
      ),
    );
    await leaveStep(run, "one", 0, "transform", { output: { n: 1 } });
    await leaveStep(run, "send", 1, "request", "dispatched");
    expect(await redeliver(run)).toEqual({ kind: "settled", status: "uncertain" });

    expect(await resolve(run, "send", "not_arrived")).toEqual({
      kind: "resolved",
      status: "queued",
      remaining: [],
    });
    const result = await continueRun(run, await redeliver(run));
    expect(result.status).toBe("succeeded");
    expect(hits).toEqual(["POST /send"]);
    const rows = (await steps(run.execution_id)).filter((step) => step.step_key === "send");
    expect(rows.map((step) => step.status)).toEqual(["skipped", "succeeded"]);
    expect(rows[1]?.write_dispatched_at).not.toBeNull();
  });

  test("reports the interrupted iteration of a for_each and keeps the finished ones", async () => {
    const run = await startedRun(
      await workflow(
        "resume-for-each",
        withConnector([
          {
            id: "items",
            kind: "transform",
            language: "javascript",
            expression: 'return ["a", "b", "c"];',
          },
          {
            id: "send",
            kind: "request",
            method: "POST",
            path: "/item",
            for_each: "(sourceData) => sourceData.items.data",
          },
        ]),
      ),
    );
    await leaveStep(run, "items", 0, "transform", { output: ["a", "b", "c"] });
    await leaveStep(run, "send", 1, "request", "running");
    await leaveStep(run, "send[0]", 1, "request", { output: { ok: true, path: "/item" } });
    await leaveStep(run, "send[1]", 1, "request", "dispatched");

    expect(await redeliver(run)).toEqual({ kind: "settled", status: "uncertain" });
    const stopped = await execution(run.execution_id);
    expect(stopped.failure?.step_id).toBe("send[1]");
    expect(
      (await steps(run.execution_id)).find((step) => step.step_key === "send[1]")?.status,
    ).toBe("uncertain");

    expect(await resolve(run, "send[1]", "arrived")).toEqual({
      kind: "resolved",
      status: "queued",
      remaining: [],
    });
    const result = await continueRun(run, await redeliver(run));
    expect(result.status).toBe("succeeded");
    expect(hits).toEqual(["POST /item"]);
    const rows = await steps(run.execution_id);
    expect(rows.filter((step) => step.step_key === "send[0]")).toHaveLength(1);
    expect(rows.filter((step) => step.step_key === "send[1]")).toHaveLength(1);
    expect(rows.filter((step) => step.step_key === "send[2]")).toHaveLength(1);
  });

  test("an uncertain run can be given up", async () => {
    const run = await startedRun(
      await workflow(
        "resume-write-cancel",
        withConnector([{ id: "send", kind: "request", method: "POST", path: "/send" }]),
      ),
    );
    await leaveStep(run, "send", 0, "request", "dispatched");
    expect(await redeliver(run)).toEqual({ kind: "settled", status: "uncertain" });
    await cancelExecutionRequest(ctx.testDb.db, {
      principal: adminPrincipal(ctx.tenantId),
      execution_id: run.execution_id,
      request_source: "api",
      boss,
    });
    expect((await execution(run.execution_id)).status).toBe("aborted");
    expect(await resolve(run, "send", "not_arrived")).toEqual({ kind: "not_uncertain" });
    expect(hits).toEqual([]);
  });

  test("fails at once when it cannot continue by itself", async () => {
    const workflow_id = await workflow("resume-held", withConnector(READS));
    const [saved] = await ctx.testDb.db
      .select({ version_id: workflows.current_version_id })
      .from(workflows)
      .where(and(eq(workflows.tenant_id, ctx.tenantId), eq(workflows.id, workflow_id)));
    const execution_id = await createExecution(ctx.testDb.db, {
      tenant_id: ctx.tenantId,
      workflow_id,
      workflow_version_id: saved?.version_id ?? null,
      source_kind: "saved",
      source_ref: null,
      request_source: "api",
      hold_writes: true,
    });
    await markExecutionRunning(ctx.testDb.db, ctx.tenantId, execution_id, new Date());
    const run = { execution_id, input: null, workflow_id };
    await leaveStep(run, "one", 0, "transform", "running");
    expect(await redeliver(run)).toEqual({ kind: "settled", status: "failed" });
    const failed = await execution(run.execution_id);
    expect(failed.status).toBe("failed");
    expect(failed.failure?.error_code).toBe("engine_crash_recovery");
    expect((await steps(run.execution_id))[0]?.status).toBe("failed");
  });

  test("keeps its heartbeat moving while a step is in flight", async () => {
    const run = await workflow(
      "resume-heartbeat",
      withConnector([{ id: "slow", kind: "request", method: "GET", path: "/slow" }]),
    );
    const admitted = await admitAuthorizedWorkflowExecution(
      {
        tenant_id: ctx.tenantId,
        workflow_id: run,
        execution_environment: "dev",
        request_source: "api",
        input: null,
      },
      ctx.testDb.db,
    );
    const beats: Array<Date | null> = [];
    upstream.setHandler(async (req, res) => {
      hits.push(`${req.method} ${req.url}`);
      beats.push((await execution(admitted.execution_id)).heartbeat_at);
      await waitFor(
        async () => {
          const beat = (await execution(admitted.execution_id)).heartbeat_at;
          return beat && beats[0] && beat.getTime() > beats[0].getTime() ? beat : null;
        },
        { tries: 200, sleepMs: 10, label: "heartbeat moved" },
      ).then((beat) => beats.push(beat));
      jsonResponse(res, 200, { ok: true, path: req.url });
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id: run },
      input: admitted.input,
      options: { existing_execution_id: admitted.execution_id, resume_authorized: true },
      heartbeat_interval_ms: 10,
    });
    upstream.setHandler((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      jsonResponse(res, 200, { ok: true, path: req.url });
    });
    expect(result.status).toBe("succeeded");
    expect(beats).toHaveLength(2);
    expect((beats[1]?.getTime() ?? 0) > (beats[0]?.getTime() ?? 0)).toBe(true);
  });

  test("is handed back to the queue by the recovery sweep", async () => {
    const run = await startedRun(await workflow("resume-sweep", withConnector(READS)));
    const jobs: ExecutionRunJob[] = [];
    const enqueue = async (job: ExecutionRunJob) => {
      jobs.push(job);
    };
    const fresh = await recoverCrashedExecutions(ctx.testDb.db, {
      now: new Date(),
      leaseMs: LEASE_MS,
      enqueue,
    });
    expect(fresh.requeued).toBe(0);
    const stale = await recoverCrashedExecutions(ctx.testDb.db, {
      now: later(),
      leaseMs: LEASE_MS,
      enqueue,
    });
    expect(stale.requeued).toBeGreaterThanOrEqual(1);
    expect(jobs).toContainEqual({
      tenant_id: ctx.tenantId,
      workflow_id: run.workflow_id,
      execution_id: run.execution_id,
    });
    expect((await execution(run.execution_id)).status).toBe("running");
  });
});
