import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { actorOfPrincipal, isRejection, type OperationScope } from "../api/operations/index.ts";
import { createTaskOperation } from "../api/operations/tasks.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { users, workflows } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { taskInput } from "../queue/handlers/task-run-turn-fixtures.ts";
import { builtinRoleId } from "../rbac/roles.ts";
import { bindFromWorkflow, createSchedule } from "../scheduler/repo.ts";
import { createDeterministicSequenceId } from "../test-helpers/determinism/index.ts";
import { seedTenant } from "../test-helpers/seed.ts";
import { personalDefaultEnvironment, writeSetupPreferences } from "./setup-preferences.ts";

let taskNumber = 0;
const nextTask = () => createDeterministicSequenceId("task", ++taskNumber);

let tdb: TestDb;
let tenant_id = "";

async function person(label: string): Promise<ResolvedPrincipal> {
  const [row] = await tdb.db
    .insert(users)
    .values({
      tenant_id,
      email: `${label}@example.test`,
      role_id: await builtinRoleId(tdb.db, "admin"),
    })
    .returning({ id: users.id });
  if (!row) throw new Error("user fixture missing");
  return { provider: "test", kind: "user", id: row.id, tenant_id, roles: ["admin"] };
}

async function create(principal: ResolvedPrincipal, environment?: "dev" | "prod") {
  const { environment: _fixed, ...rest } = taskInput({ name: `Task ${nextTask()}` });
  const scope: OperationScope = {
    db: tdb.db as OperationScope["db"],
    tenant_id,
    principal,
    actor: actorOfPrincipal(principal),
  };
  const created = await createTaskOperation.handler(scope, {
    ...rest,
    ...(environment ? { environment } : {}),
  });
  if (isRejection(created)) throw new Error("task creation was rejected");
  return created.environment;
}

beforeAll(async () => {
  tdb = await createTestDb("default-environment");
  tenant_id = (await seedTenant(tdb.db, { slug: "default-env" })).id;
}, 120_000);

afterAll(async () => {
  await tdb?.cleanup();
}, 30_000);

describe("the person's default environment", () => {
  test("a new task without an environment takes the person's choice", async () => {
    const undecided = await person("undecided");
    const production = await person("production");
    await writeSetupPreferences(
      tdb.db,
      { tenant_id, user_id: production.id },
      { default_environment: "prod" },
    );
    expect(await create(undecided)).toBe("dev");
    expect(await create(production)).toBe("prod");
    expect(await create(production, "dev")).toBe("dev");
    expect(await create(undecided, "prod")).toBe("prod");
  });

  test("only a person of the same workspace has a default", async () => {
    const owner = await person("owner");
    await writeSetupPreferences(
      tdb.db,
      { tenant_id, user_id: owner.id },
      { default_environment: "prod" },
    );
    expect(await personalDefaultEnvironment(tdb.db, tenant_id, owner)).toBe("prod");
    expect(await personalDefaultEnvironment(tdb.db, tenant_id, null)).toBeNull();
    expect(
      await personalDefaultEnvironment(tdb.db, tenant_id, { ...owner, kind: "system_account" }),
    ).toBeNull();
    expect(
      await personalDefaultEnvironment(tdb.db, tenant_id, {
        ...owner,
        tenant_id: "00000000-0000-4000-8000-000000000000",
      }),
    ).toBeNull();
  });
});

async function workflow(slug: string): Promise<string> {
  const [row] = await tdb.db
    .insert(workflows)
    .values({ tenant_id, slug, name: slug, lifecycle: "active" })
    .returning({ id: workflows.id });
  if (!row) throw new Error("workflow fixture missing");
  return row.id;
}

async function schedule(
  creator: ResolvedPrincipal | null,
  workflow_id: string,
  execution_mode?: "dev" | "prod",
) {
  const { row } = await createSchedule(tdb.db, {
    tenant_id,
    workflow_id,
    cron: "0 8 * * *",
    ...(execution_mode ? { execution_mode } : {}),
    creator,
  });
  return row.execution_mode;
}

describe("a new schedule's environment", () => {
  test("follows the creator's setup default, otherwise dev", async () => {
    const undecided = await person("schedule-undecided");
    const production = await person("schedule-production");
    await writeSetupPreferences(
      tdb.db,
      { tenant_id, user_id: production.id },
      { default_environment: "prod" },
    );
    expect(await schedule(undecided, await workflow("sched-undecided"))).toBe("dev");
    expect(await schedule(production, await workflow("sched-production"))).toBe("prod");
    expect(await schedule(null, await workflow("sched-nobody"))).toBe("dev");
    expect(await schedule(production, await workflow("sched-explicit"), "dev")).toBe("dev");
  });

  test("an existing schedule keeps its environment when none is asked for", async () => {
    const production = await person("schedule-keeper");
    const workflow_id = await workflow("sched-kept");
    expect(await schedule(null, workflow_id, "prod")).toBe("prod");
    expect(await schedule(null, workflow_id)).toBe("prod");
    expect(await schedule(production, workflow_id, "dev")).toBe("dev");
    expect(await schedule(production, workflow_id)).toBe("dev");
  });

  test("a schedule bound from a workflow trigger follows its author's default", async () => {
    const author = await person("schedule-author");
    await writeSetupPreferences(
      tdb.db,
      { tenant_id, user_id: author.id },
      { default_environment: "prod" },
    );
    const bound = await bindFromWorkflow(tdb.db, {
      tenant_id,
      workflow_id: await workflow("sched-bound"),
      trigger: { kind: "schedule", cron: "0 8 * * *", tz: "UTC" },
      actor_id: author.id,
      actor_type: "user",
    });
    expect(bound.row.execution_mode).toBe("prod");
    const anonymous = await bindFromWorkflow(tdb.db, {
      tenant_id,
      workflow_id: await workflow("sched-bound-system"),
      trigger: { kind: "schedule", cron: "0 8 * * *", tz: "UTC" },
      actor_id: null,
      actor_type: "system",
    });
    expect(anonymous.row.execution_mode).toBe("dev");
  });
});
