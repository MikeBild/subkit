import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { and, asc } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { writeEvent } from "../../db/events.ts";
import { events, tasks } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { cockpitStreamConds, projectCockpitPayload } from "../../identity/cockpit-stream.ts";
import { adminPrincipal } from "../../test-helpers/principals.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { type AppEnv, OPENAPI_INFO } from "../openapi.ts";
import { registerCockpitEventRoutes } from "./cockpit-events.ts";

let ctx: TestDb;
let tenantA = "";
let tenantB = "";
const WORKFLOW = "11111111-1111-4111-8111-111111111111";
const EXECUTION = "22222222-2222-4222-8222-222222222222";
const CONNECTOR = "33333333-3333-4333-8333-333333333333";
const TASK_OWNER = "44444444-4444-4444-8444-444444444444";
const COLLEAGUE = "55555555-5555-4555-8555-555555555555";
const RUN = "66666666-6666-4666-8666-666666666666";
const GRANT = "77777777-7777-4777-8777-777777777777";

async function seedTask(tenant_id: string, owner_id: string): Promise<string> {
  const [row] = await ctx.db
    .insert(tasks)
    .values({
      tenant_id,
      name: "Weekly report",
      category: "reports",
      category_source: "human",
      description_source: "human",
      owner_id,
      goal: "Send the weekly report",
      done_when: "The report is in the inbox",
      plan: { title: "Report", goal: "Send the weekly report", steps: [] },
      bindings: { workflow_ids: [], connector_ids: [], skill_slugs: [], web_search: false },
      environment: "prod",
      fingerprint: "a".repeat(64),
    })
    .returning({ id: tasks.id });
  if (!row) throw new Error("task fixture missing");
  return row.id;
}

interface Frame {
  id?: string;
  event?: string;
  data?: Record<string, unknown>;
}

function appFor(principal: ResolvedPrincipal) {
  const app = new OpenAPIHono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", ctx.db as never);
    c.set("principal", principal);
    await next();
  });
  registerCockpitEventRoutes(app);
  return app;
}

const open: AbortController[] = [];

function openStream(principal: ResolvedPrincipal, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  open.push(controller);
  return appFor(principal).request("/v1/cockpit/events/stream", {
    headers,
    signal: controller.signal,
  });
}

async function frames(
  res: Response,
  until: (seen: Frame[]) => boolean,
  budgetMs = 5_000,
): Promise<Frame[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const seen: Frame[] = [];
  let buffer = "";
  const deadline = Date.now() + budgetMs; // allow-wall-clock: bounded SSE read
  let pending: ReturnType<typeof reader.read> | null = null;
  try {
    // allow-wall-clock: bounded SSE read
    while (!until(seen) && Date.now() < deadline) {
      pending ??= reader.read();
      const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 250));
      const chunk = await Promise.race([pending, timeout]);
      if (chunk === null) continue;
      pending = null;
      if (chunk.done) break;
      if (!chunk.value) continue;
      buffer += decoder.decode(chunk.value, { stream: true });
      let cut = buffer.indexOf("\n\n");
      while (cut !== -1) {
        const frame: Frame = {};
        for (const line of buffer.slice(0, cut).split("\n")) {
          if (line.startsWith("id:")) frame.id = line.slice(3).trim();
          else if (line.startsWith("event:")) frame.event = line.slice(6).trim();
          else if (line.startsWith("data:")) frame.data = JSON.parse(line.slice(5).trim());
        }
        seen.push(frame);
        buffer = buffer.slice(cut + 2);
        cut = buffer.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    for (const controller of open.splice(0)) controller.abort();
  }
  return seen;
}

async function emit(
  tenant_id: string,
  channel: Parameters<typeof writeEvent>[1]["channel"],
  type: string,
  payload: Record<string, unknown>,
): Promise<number> {
  return writeEvent(ctx.db, { tenant_id, channel, type, payload });
}

beforeAll(async () => {
  ctx = await createTestDb("cockpit_events_stream");
  const a = await seedTenant(ctx.db, { slug: "cockpit-stream-a", display_name: "A" });
  const b = await seedTenant(ctx.db, { slug: "cockpit-stream-b", display_name: "B" });
  tenantA = a.id;
  tenantB = b.id;
});

afterAll(async () => {
  await Bun.sleep(500); // allow-wall-clock: drain the last poll before the pool closes
  await ctx.cleanup();
});

describe("GET /v1/cockpit/events/stream", () => {
  test("starts at the tail, carries the engine version, then hears its own tenant only", async () => {
    await emit(tenantA, "execution.status", "execution.queued", { execution_id: EXECUTION });
    const res = await openStream(adminPrincipal(tenantA));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const pending = frames(res, (seen) => seen.some((f) => f.event === "execution.succeeded"));
    await Bun.sleep(400); // allow-wall-clock: let the stream announce its tail first
    await emit(tenantB, "execution.status", "execution.failed", { execution_id: EXECUTION });
    await emit(tenantA, "execution.status", "execution.succeeded", { execution_id: EXECUTION });
    const seen = await pending;
    expect(seen[0]?.event).toBe("hello");
    expect(seen[0]?.data).toMatchObject({ version: OPENAPI_INFO.version, truncated: false });
    const changes = seen.filter((f) => f.event !== "hello" && f.event !== "ping");
    expect(changes.map((f) => f.event)).toEqual(["execution.succeeded"]);
  });

  test("resumes after Last-Event-ID", async () => {
    const first = await emit(tenantA, "workflow.lifecycle", "workflow.updated", {
      workflow_id: WORKFLOW,
      actor_id: null,
      slug: "s",
    });
    await emit(tenantA, "workflow.lifecycle", "workflow.deleted", {
      workflow_id: WORKFLOW,
      actor_id: null,
    });
    const res = await openStream(adminPrincipal(tenantA), { "last-event-id": String(first - 1) });
    const seen = await frames(res, (s) => s.some((f) => f.event === "hello"));
    expect(seen.map((f) => f.event)).toEqual(["workflow.updated", "workflow.deleted", "hello"]);
    expect(seen[0]?.id).toBe(String(first));
  });

  test("frames carry ids only", async () => {
    const id = await emit(tenantA, "skill.lifecycle", "skill.created", {
      skill_id: CONNECTOR,
      title: "Quarterly close",
      actor_id: "someone",
      secret: "s3cr3t",
    });
    const res = await openStream(adminPrincipal(tenantA), { "last-event-id": String(id - 1) });
    const seen = await frames(res, (s) => s.some((f) => f.event === "hello"));
    expect(seen[0]).toEqual({
      id: String(id),
      event: "skill.created",
      data: { skill_id: CONNECTOR },
    });
  });

  test("a reader without connector:read never hears a connector change", async () => {
    const before = await emit(tenantA, "event.emitted", "noise", {});
    await emit(tenantA, "resource.lifecycle", "connector.updated", { connector_id: CONNECTOR });
    await emit(tenantA, "execution.status", "execution.started", { execution_id: EXECUTION });
    const enduser: ResolvedPrincipal = {
      provider: "api_key",
      kind: "user",
      id: "00000000-0000-4000-8000-0000000000e1",
      tenant_id: tenantA,
      roles: ["enduser"],
    };
    const res = await openStream(enduser, { "last-event-id": String(before) });
    const seen = await frames(res, (s) => s.some((f) => f.event === "hello"));
    expect(seen.map((f) => f.event)).toEqual(["execution.started", "hello"]);
  });
});

describe("cockpitStreamConds", () => {
  test("the permission filter is in SQL: no execution:read, no execution rows", async () => {
    await emit(tenantA, "execution.status", "execution.queued", { execution_id: EXECUTION });
    await emit(tenantA, "resource.lifecycle", "workflow.authority_granted", {
      workflow_id: WORKFLOW,
    });
    await emit(tenantA, "conversation.stream", "text-delta", { conversation_id: WORKFLOW });
    await emit(tenantA, "notification.emitted", "file.finalized", { file_id: WORKFLOW });
    const conds = cockpitStreamConds(tenantA, new Set(["workflow:read", "connector:read"]));
    const rows = await ctx.db
      .select({ channel: events.channel, type: events.type })
      .from(events)
      .where(and(...(conds ?? [])))
      .orderBy(asc(events.id));
    expect(rows.some((row) => row.channel === "execution.status")).toBe(false);
    expect(rows.some((row) => row.channel === "conversation.stream")).toBe(false);
    expect(rows.some((row) => row.type.startsWith("file."))).toBe(false);
    expect(rows.some((row) => row.type === "workflow.authority_granted")).toBe(true);
    expect(cockpitStreamConds(tenantA, new Set())).toBeNull();
  });

  test("each list family reaches only readers of that list; audit readers hear every change", async () => {
    const changes = [
      ["knowledge:read", "knowledge_source.changed"],
      ["file:read", "file.changed"],
      ["identity:read", "identity.changed"],
      ["rbac:read", "rbac.changed"],
      ["api_key:read", "api_key.changed"],
      ["settings:read", "settings.changed"],
    ] as const;
    const first = await emit(tenantA, "resource.lifecycle", changes[0][1], {});
    for (const [, type] of changes.slice(1)) await emit(tenantA, "resource.lifecycle", type, {});
    const heard = async (permissions: string[]) => {
      const conds = cockpitStreamConds(tenantA, new Set(permissions));
      const rows = await ctx.db
        .select({ id: events.id, type: events.type })
        .from(events)
        .where(and(...(conds ?? [])))
        .orderBy(asc(events.id));
      return rows.filter((row) => row.id >= first).map((row) => row.type);
    };
    for (const [permission, type] of changes) expect(await heard([permission])).toEqual([type]);
    expect(await heard(["audit:read"])).toEqual(changes.map(([, type]) => type));
    expect(await heard(["workflow:read", "connector:read", "execution:read"])).toEqual([]);
  });

  test("task changes reach the task's owner and admins, nobody else", async () => {
    const own = await seedTask(tenantA, TASK_OWNER);
    const theirs = await seedTask(tenantA, COLLEAGUE);
    const foreign = await seedTask(tenantB, TASK_OWNER);
    const first = await emit(tenantA, "resource.lifecycle", "task.changed", { task_id: own });
    await emit(tenantA, "resource.lifecycle", "task_run.changed", {
      task_id: own,
      task_run_id: RUN,
    });
    await emit(tenantA, "resource.lifecycle", "task.grant_changed", {
      task_id: own,
      task_grant_id: GRANT,
    });
    await emit(tenantA, "resource.lifecycle", "task.changed", { task_id: theirs });
    await emit(tenantA, "resource.lifecycle", "task_run.changed", {
      task_id: theirs,
      task_run_id: RUN,
    });
    await emit(tenantA, "resource.lifecycle", "task.changed", { task_id: foreign });
    await emit(tenantA, "resource.lifecycle", "task.changed", {});
    await emit(tenantB, "resource.lifecycle", "task.changed", { task_id: foreign });
    const heard = async (permissions: string[], viewer?: { task_owner_id: string | null }) => {
      const conds = cockpitStreamConds(tenantA, new Set(permissions), viewer);
      if (!conds) return [];
      const rows = await ctx.db
        .select({ id: events.id, type: events.type, payload: events.payload })
        .from(events)
        .where(and(...conds))
        .orderBy(asc(events.id));
      return rows
        .filter((row) => row.id >= first)
        .map((row) => [row.type, (row.payload as { task_id?: string }).task_id ?? null]);
    };
    const ownEvents = [
      ["task.changed", own],
      ["task_run.changed", own],
      ["task.grant_changed", own],
    ];
    expect(await heard(["task:read"], { task_owner_id: TASK_OWNER })).toEqual(ownEvents);
    expect(await heard(["task:read"], { task_owner_id: COLLEAGUE })).toEqual([
      ["task.changed", theirs],
      ["task_run.changed", theirs],
    ]);
    expect(await heard(["task:read"], { task_owner_id: null })).toEqual([
      ...ownEvents,
      ["task.changed", theirs],
      ["task_run.changed", theirs],
      ["task.changed", foreign],
      ["task.changed", null],
    ]);
    expect(await heard(["task:read"])).toEqual([]);
    expect(await heard(["workflow:read", "execution:read"], { task_owner_id: null })).toEqual([]);
    expect(await heard(["audit:read"], { task_owner_id: TASK_OWNER })).toEqual(ownEvents);
    expect(await heard(["audit:read"])).toEqual([]);
    expect(await heard(["audit:read"], { task_owner_id: null })).toHaveLength(7);
  });

  test("the stream hands a member only the changes of own tasks, as ids", async () => {
    const own = await seedTask(tenantA, TASK_OWNER);
    const theirs = await seedTask(tenantA, COLLEAGUE);
    const before = await emit(tenantA, "event.emitted", "noise", {});
    await emit(tenantA, "resource.lifecycle", "task_run.changed", {
      task_id: theirs,
      task_run_id: RUN,
    });
    await emit(tenantA, "resource.lifecycle", "task_run.changed", {
      task_id: own,
      task_run_id: RUN,
      goal: "Send the weekly report",
    });
    const member: ResolvedPrincipal = {
      provider: "api_key",
      kind: "user",
      id: TASK_OWNER,
      tenant_id: tenantA,
      roles: ["member"],
    };
    const mine = await frames(await openStream(member, { "last-event-id": String(before) }), (s) =>
      s.some((f) => f.event === "hello"),
    );
    expect(mine.filter((f) => f.event === "task_run.changed").map((f) => f.data)).toEqual([
      { task_id: own, task_run_id: RUN },
    ]);
    const admins = await frames(
      await openStream(adminPrincipal(tenantA), { "last-event-id": String(before) }),
      (s) => s.some((f) => f.event === "hello"),
    );
    expect(
      admins.filter((f) => f.event === "task_run.changed").map((f) => f.data?.task_id),
    ).toEqual([theirs, own]);
  });

  test("projection keeps the task ids", () => {
    expect(
      projectCockpitPayload({
        task_id: WORKFLOW,
        task_run_id: RUN,
        task_grant_id: GRANT,
        goal: "x",
      }),
    ).toEqual({ task_id: WORKFLOW, task_run_id: RUN, task_grant_id: GRANT });
  });

  test("projection keeps id-shaped values of allowlisted keys only", () => {
    expect(
      projectCockpitPayload({
        workflow_id: WORKFLOW,
        execution_id: "not an id; has spaces",
        error: { message: "boom" },
        name: "Payroll",
      }),
    ).toEqual({ workflow_id: WORKFLOW });
    expect(projectCockpitPayload(null)).toEqual({});
    expect(projectCockpitPayload([WORKFLOW])).toEqual({});
  });
});
