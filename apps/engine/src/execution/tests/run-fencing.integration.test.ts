import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { _resetConfigForTests, loadConfig, setConfigKey } from "../../config/loader.ts";
import {
  auditLog,
  connectors,
  executions,
  workflowExecutionAuthorities,
} from "../../db/schema/index.ts";
import { databaseNow } from "../../test-helpers/database-clock.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { previewWorkflowAuthority } from "../../workflows/execution-authorities.ts";
import { admitAuthorizedWorkflowExecution } from "../authority-admission.ts";
import { runExecution } from "../engine.ts";
import { planResume, type ResumePlan } from "../recovery.ts";
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

beforeAll(async () => {
  ctx = await createEngineCtx("run-fencing");
  configDir = mkdtempSync(join(tmpdir(), "subkit-run-fencing-"));
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

function withConnector(list: unknown[]): unknown[] {
  return list.map((step) => ({ ...(step as object), connector_id: connectorId }));
}

async function execution(execution_id: string) {
  const [row] = await ctx.testDb.db
    .select()
    .from(executions)
    .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, execution_id)));
  if (!row) throw new Error("execution missing");
  return row;
}

interface Admitted {
  execution_id: string;
  input: unknown;
  workflow_id: string;
}

function redeliver(run: Admitted): Promise<ResumePlan> {
  return planResume(ctx.testDb.db, {
    tenant_id: ctx.tenantId,
    execution_id: run.execution_id,
    now: new Date(Date.now() + LEASE_MS * 2),
    lease_ms: LEASE_MS,
  });
}

function continueRun(run: Admitted, plan: ResumePlan) {
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

describe("a run taken over by another copy", () => {
  test("a stalled copy sends no change after another copy took the run over", async () => {
    const workflow_id = await workflow(
      "resume-fenced",
      withConnector([
        { id: "first", kind: "request", method: "GET", path: "/first" },
        { id: "send", kind: "request", method: "POST", path: "/send" },
      ]),
    );
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
    const run = { execution_id: admitted.execution_id, input: admitted.input, workflow_id };
    const gates: Array<() => void> = [];
    let reads = 0;
    upstream.setHandler(async (req, res) => {
      hits.push(`${req.method} ${req.url}`);
      if (req.method === "GET") {
        reads += 1;
        await new Promise<void>((release) => gates.push(release));
      }
      jsonResponse(res, 200, { ok: true, path: req.url });
    });
    try {
      const stalled = runExecution({
        db: ctx.testDb.db,
        tenant_id: ctx.tenantId,
        source: { kind: "saved", workflow_id },
        input: admitted.input,
        options: { existing_execution_id: admitted.execution_id, resume_authorized: true },
      });
      await waitFor(async () => (reads === 1 ? true : null), {
        tries: 500,
        sleepMs: 10,
        label: "stalled copy is reading",
      });

      const plan = await redeliver(run);
      expect(plan.kind).toBe("run");
      expect((await execution(run.execution_id)).attempt).toBe(1);
      const takeover = continueRun(run, plan);
      await waitFor(async () => (reads === 2 ? true : null), {
        tries: 500,
        sleepMs: 10,
        label: "second copy is reading",
      });

      gates[0]?.();
      const stalledResult = await stalled;
      expect(stalledResult.error?.code).toBe("execution_superseded");
      expect(hits.filter((hit) => hit.startsWith("POST"))).toEqual([]);
      const meanwhile = await execution(run.execution_id);
      expect(meanwhile.status).toBe("running");
      expect(meanwhile.finished_at).toBeNull();

      gates[1]?.();
      const result = await takeover;
      expect(result.status).toBe("succeeded");
      expect(hits.filter((hit) => hit.startsWith("POST"))).toEqual(["POST /send"]);
      const settled = await execution(run.execution_id);
      expect(settled.status).toBe("succeeded");
      expect(settled.attempt).toBe(1);
      const completed = await ctx.testDb.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenant_id, ctx.tenantId),
            eq(auditLog.resource_id, run.execution_id),
            inArray(auditLog.action, ["execution.completed", "execution.aborted"]),
          ),
        );
      expect(completed.map((row) => row.action)).toEqual(["execution.completed"]);
    } finally {
      upstream.setHandler((req, res) => {
        hits.push(`${req.method} ${req.url}`);
        jsonResponse(res, 200, { ok: true, path: req.url });
      });
    }
  });
});
