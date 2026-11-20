import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { _resetConfigForTests, loadConfig, setConfigKey } from "../../config/loader.ts";
import { hostedWorkAdmissions, roles, taskRuns, tenants, users } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { resetMockProvider } from "../../llm/mock-provider.ts";
import { sweepTenantTasks } from "../../scheduler/task-sweep.ts";
import { createTask, startTaskRun } from "../../tasks/index.ts";
import { configureHostedPolicyForTests } from "../../test-helpers/hosted-policy.ts";
import { provisionTestWorkspace } from "../../test-helpers/workspace-registration.ts";
import { createBoss, disposeBoss } from "../boss.ts";
import { TASK_RUN_TURN_QUEUE } from "../queues.ts";
import {
  enqueueTaskRunTurn,
  handleTaskRunTurnJob,
  type TaskRunTurnJob,
  useTaskRunTurnBoss,
} from "./task-run-turn.ts";
import { taskInput } from "./task-run-turn-fixtures.ts";

let tdb: TestDb;
let boss: PgBoss;
let dir: string;

beforeAll(async () => {
  process.env.LLM_PROVIDER = "mock";
  resetMockProvider();
  tdb = await createTestDb("task-run-turn-hosted");
  await tdb.db
    .insert(tenants)
    .values({ slug: "task-run-operator", display_name: "Operator", is_operator: true });
  boss = await createBoss({ connectionString: tdb.url });
  dir = mkdtempSync(join(tmpdir(), "sk-task-run-hosted-"));
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: tdb.url, NODE_ENV: "test" },
    configPathOverride: join(dir, "seed.json"),
  });
  await configureHostedPolicyForTests(tdb.db, tdb.url);
  await setConfigKey("queue.hosted.execution_concurrency", 1);
  await setConfigKey("queue.hosted.chat_concurrency", 1);
  await setConfigKey("queue.hosted.pending_jobs", 1);
  useTaskRunTurnBoss(boss);
}, 120_000);

afterAll(async () => {
  useTaskRunTurnBoss(null);
  _resetConfigForTests();
  rmSync(dir, { recursive: true, force: true });
  await disposeBoss(boss);
  await tdb.cleanup();
}, 60_000);

async function hostedOwner(subject: string): Promise<ResolvedPrincipal> {
  const { tenant } = await provisionTestWorkspace(subject, tdb.db);
  const [owner] = await tdb.db
    .select({ id: users.id, role: roles.name })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.role_id))
    .where(eq(users.tenant_id, tenant.id))
    .limit(1);
  if (!owner) throw new Error("missing workspace owner");
  return {
    provider: "session",
    kind: "user",
    id: owner.id,
    tenant_id: tenant.id,
    roles: [owner.role],
  };
}

async function startRun(owner: ResolvedPrincipal, name: string): Promise<TaskRunTurnJob> {
  const task = await createTask(
    { tenant_id: owner.tenant_id, principal: owner, input: taskInput({ name }) },
    tdb.db,
  );
  const started = await startTaskRun(
    { tenant_id: owner.tenant_id, task_id: task.id, trigger: "manual", started_by: owner },
    tdb.db,
  );
  if (!started.admitted) throw new Error(`not admitted: ${started.reason}`);
  return { tenant_id: owner.tenant_id, task_id: task.id, task_run_id: started.run.id };
}

async function admissions(tenant_id: string) {
  return await tdb.db
    .select({ state: hostedWorkAdmissions.state, kind: hostedWorkAdmissions.kind })
    .from(hostedWorkAdmissions)
    .where(
      and(
        eq(hostedWorkAdmissions.tenant_id, tenant_id),
        eq(hostedWorkAdmissions.queue_name, TASK_RUN_TURN_QUEUE),
      ),
    );
}

test("a hosted workspace queues a run turn under its work quota and a full workspace waits for the sweep", async () => {
  const owner = await hostedOwner("task-run-hosted");
  const first = await startRun(owner, "First");
  const second = await startRun(owner, "Second");
  const queued = await enqueueTaskRunTurn(tdb.db, first);
  expect(queued).toBeString();
  expect(await enqueueTaskRunTurn(tdb.db, first)).toBeNull();
  expect(await enqueueTaskRunTurn(tdb.db, second)).toBeNull();
  expect(await admissions(owner.tenant_id)).toEqual([{ state: "pending", kind: "chat" }]);

  const [job] = await boss.fetch<TaskRunTurnJob>(TASK_RUN_TURN_QUEUE);
  expect(job?.id).toBe(queued as string);
  let turns = 0;
  await handleTaskRunTurnJob(job as never, tdb.db, boss, {
    runTurn: async () => {
      turns++;
      return {} as never;
    },
  });
  await boss.complete(TASK_RUN_TURN_QUEUE, queued as string);
  expect(turns).toBe(1);
  const [run] = await tdb.db
    .select({ state: taskRuns.state, turns_used: taskRuns.turns_used })
    .from(taskRuns)
    .where(and(eq(taskRuns.tenant_id, owner.tenant_id), eq(taskRuns.id, first.task_run_id)));
  expect(run).toEqual({ state: "running", turns_used: 1 });

  // allow-wall-clock: the sweep compares this instant with rows stamped by the real clock
  await sweepTenantTasks(tdb.db, owner.tenant_id, new Date());
  const states = (await admissions(owner.tenant_id)).map((row) => row.state).sort();
  expect(states.filter((state) => state === "pending")).toHaveLength(1);
  expect(states).toContain("released");
}, 180_000);
