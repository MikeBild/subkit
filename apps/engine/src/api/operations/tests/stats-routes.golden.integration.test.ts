import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  executions,
  llmUsage,
  users,
  workflows,
  workflowVersions,
} from "../../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../http/tests/setup.ts";
import { createRole, grantPermissionToRole } from "../../../rbac/roles.ts";
import {
  createDeterministicHexFactory,
  createDeterministicUuidFactory,
} from "../../../test-helpers/determinism/ids.ts";
import { emptyRoleId } from "../../../test-helpers/roles.ts";

const GOLDEN_PATH = new URL("./fixtures/stats-routes.golden.json", import.meta.url).pathname;
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, string>;
const actual: Record<string, string> = {};
const uuid = createDeterministicUuidFactory(0x57_a8);
const CONNECTOR_ID = uuid();
const OTHER_USER_ID = uuid();
const PATHS = [
  "executions",
  "connectors",
  "events",
  "llm",
  "operating-figures",
  "quality",
] as const;

let ctx: HttpTestServer;
let deniedKey: string;
let statsReaderKey: string;
let statsReaderId = "";

function normalize(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll(ctx.tenantId, "<tenant>")
    .replaceAll(statsReaderId || "<none>", "<stats-reader>")
    .replace(/"(trace_id|audit_trace_id|request_id)":"[^"]*"/g, '"$1":"<trace>"')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>");
}

function record(name: string, value: unknown): void {
  actual[name] = normalize(value);
  expect(actual[name]).toBe(golden[name] as string);
}

async function http(
  method: string,
  path: string,
  key = ctx.apiKey,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}` },
  });
  const text = await res.text();
  const json = res.headers.get("content-type")?.includes("application/json") ?? false;
  return { status: res.status, body: text ? (json ? JSON.parse(text) : text) : null };
}

function window(bucket: string, from: string, to: string, extra = ""): string {
  return `bucket=${bucket}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${extra}`;
}

const DAY_WINDOW = window("hour", "2026-01-15T00:00:00.000Z", "2026-01-16T00:00:00.000Z");
const BEFORE_HORIZON = window("hour", "2026-01-14T00:00:00.000Z", "2026-01-15T00:00:00.000Z");
const ACROSS_HORIZON = window("day", "2026-01-10T00:00:00.000Z", "2026-01-16T00:00:00.000Z");

async function seedKey(email: string, roleId: string, seed: number) {
  const [user] = await ctx.db
    .insert(users)
    .values({ tenant_id: ctx.tenantId, email, role_id: roleId })
    .returning();
  if (!user) throw new Error("user insert returned no row");
  const key = `wf_live_${createDeterministicHexFactory(seed)(16)}`;
  await ctx.testDb.pool.query(
    "INSERT INTO subkit.api_keys (tenant_id, user_id, prefix, token_sha256, scopes) VALUES ($1, $2, $3, $4, $5::jsonb)",
    [
      ctx.tenantId,
      user.id,
      key.slice(0, 12),
      createHash("sha256").update(key).digest("hex"),
      JSON.stringify(["*"]),
    ],
  );
  return { key, id: user.id };
}

async function seedFacts(): Promise<void> {
  const [workflow] = await ctx.db
    .insert(workflows)
    .values({ tenant_id: ctx.tenantId, slug: "stats-golden", name: "Stats", lifecycle: "active" })
    .returning();
  if (!workflow) throw new Error("workflow insert returned no row");
  const [version] = await ctx.db
    .insert(workflowVersions)
    .values({ tenant_id: ctx.tenantId, workflow_id: workflow.id, version: 1, dag: { steps: [] } })
    .returning();
  if (!version) throw new Error("workflow version insert returned no row");
  const start = Date.parse("2026-01-15T08:00:00.000Z");
  await ctx.db.insert(executions).values(
    [10_000, 20_000, 30_000].map((duration, i) => ({
      tenant_id: ctx.tenantId,
      workflow_id: workflow.id,
      workflow_version_id: version.id,
      status: i === 1 ? ("failed" as const) : ("succeeded" as const),
      request_source: i === 2 ? "wait_reaper" : "api",
      execution_mode: "prod" as const,
      started_at: new Date(start + i * 3_600_000),
      finished_at: new Date(start + i * 3_600_000 + duration),
    })),
  );
  const connectorCall = (offset: number, result: "success" | "error", status: string) => ({
    id: uuid(),
    ts: new Date(start + offset),
    tenant_id: ctx.tenantId,
    actor_type: "system" as const,
    action: "connector.invoked",
    resource_type: "connector",
    resource_id: CONNECTOR_ID,
    result,
    metadata: {
      connector_id: CONNECTOR_ID,
      connector_slug: "api-a",
      driver: "rest",
      method: "GET",
      endpoint: "/items",
      status_code: status,
      latency_ms: String(100 + offset),
    },
  });
  await ctx.db.insert(auditLog).values([
    connectorCall(0, "success", "200"),
    connectorCall(1000, "error", "500"),
    connectorCall(3_600_000, "success", "200"),
    {
      id: uuid(),
      ts: new Date(start + 2000),
      tenant_id: ctx.tenantId,
      actor_type: "system" as const,
      action: "schedule.trigger.fired",
      resource_type: "workflow",
      resource_id: workflow.id,
      result: "success",
      metadata: {},
    },
  ]);
  await ctx.db.insert(llmUsage).values(
    [
      ["converse", "claude-haiku-4-5", 100, 50, 10, "success"],
      ["converse", "claude-haiku-4-5", 120, 40, 0, "error"],
      ["extract", "claude-sonnet-4-6", 200, 100, 20, "success"],
    ].map(([flow, model, prompt, completion, cacheRead, result], i) => ({
      tenant_id: ctx.tenantId,
      flow: flow as string,
      model: model as string,
      prompt_tokens: prompt as number,
      completion_tokens: completion as number,
      total_tokens: (prompt as number) + (completion as number),
      cache_read_tokens: cacheRead as number,
      cache_creation_tokens: 0,
      latency_ms: 500 + i * 100,
      result: result as string,
      month_bucket: 202601,
      created_at: new Date(start + i * 3_600_000),
    })),
  );
}

beforeAll(async () => {
  ctx = await createHttpTestServer("operations_stats_routes_golden");
  await seedFacts();
  deniedKey = (
    await seedKey(
      "denied-stats-routes@test.local",
      await emptyRoleId(ctx.db, ctx.tenantId),
      0x57_a9,
    )
  ).key;
  const role = await createRole(ctx.db, ctx.tenantId, "stats-routes-reader");
  await grantPermissionToRole(ctx.db, ctx.tenantId, role.id, "stats:read");
  const reader = await seedKey("reader-stats-routes@test.local", role.id, 0x57_aa);
  statsReaderKey = reader.key;
  statsReaderId = reader.id;
}, 60_000);

afterAll(async () => {
  await ctx?.cleanup();
});

describe("stats routes keep their HTTP responses byte for byte", () => {
  test("executions", async () => {
    const path = "/v1/stats/executions";
    record("executions", await http("GET", `${path}?${DAY_WINDOW}`));
    record(
      "executions.grouped",
      await http("GET", `${path}?${DAY_WINDOW}&group_by=status,request_source,nope&status=failed`),
    );
    record(
      "executions.tz",
      await http(
        "GET",
        `${path}?${window("day", "2026-01-14T00:00:00.000Z", "2026-01-17T00:00:00.000Z")}&tz=Europe/Berlin&execution_mode=prod`,
      ),
    );
    record("executions.missing-bucket", await http("GET", `${path}?from=2026-01-15T00:00:00Z`));
    record("executions.bad-bucket", await http("GET", `${path}?bucket=week&from=2026-01-15`));
    record("executions.from-invalid", await http("GET", `${path}?bucket=hour&from=yesterday`));
    record(
      "executions.to-invalid",
      await http("GET", `${path}?bucket=hour&from=2026-01-15T00:00:00Z&to=later`),
    );
    record(
      "executions.window-empty",
      await http(
        "GET",
        `${path}?${window("hour", "2026-01-15T00:00:00.000Z", "2026-01-14T00:00:00.000Z")}`,
      ),
    );
    record(
      "executions.too-large",
      await http(
        "GET",
        `${path}?${window("minute", "2026-01-10T00:00:00.000Z", "2026-01-15T00:00:00.000Z")}`,
      ),
    );
    record("executions.tz-invalid", await http("GET", `${path}?${DAY_WINDOW}&tz=Mars/Base`));
    record(
      "executions.workflow-invalid",
      await http("GET", `${path}?${DAY_WINDOW}&workflow_id=nope`),
    );
  });

  test("connectors", async () => {
    const path = "/v1/stats/connectors";
    record("connectors", await http("GET", `${path}?${DAY_WINDOW}`));
    record(
      "connectors.grouped",
      await http(
        "GET",
        `${path}?${DAY_WINDOW}&group_by=connector_slug,status_class,bogus&outcome=success,error,bogus&status_class=2xx,5xx,bogus&include_endpoint=true`,
      ),
    );
    record(
      "connectors.filtered",
      await http(
        "GET",
        `${path}?${DAY_WINDOW}&connector_id=${CONNECTOR_ID}&connector_slug=api-a&driver=rest&method=GET`,
      ),
    );
    record("connectors.truncated", await http("GET", `${path}?${ACROSS_HORIZON}`));
    record("connectors.before-horizon", await http("GET", `${path}?${BEFORE_HORIZON}`));
    record("connectors.window-empty", await http("GET", `${path}?bucket=hour&from=nope`));
  });

  test("events", async () => {
    const path = "/v1/stats/events";
    record("events", await http("GET", `${path}?${DAY_WINDOW}&class=schedule`));
    record(
      "events.grouped",
      await http(
        "GET",
        `${path}?${DAY_WINDOW}&class=schedule&group_by=outcome,bogus&outcome=success,bogus`,
      ),
    );
    record("events.empty-class", await http("GET", `${path}?${DAY_WINDOW}&class=policy`));
    record("events.truncated", await http("GET", `${path}?${ACROSS_HORIZON}&class=schedule`));
    record("events.before-horizon", await http("GET", `${path}?${BEFORE_HORIZON}&class=schedule`));
    record("events.missing-class", await http("GET", `${path}?${DAY_WINDOW}`));
    record("events.bad-class", await http("GET", `${path}?${DAY_WINDOW}&class=bogus`));
    record("events.tz-invalid", await http("GET", `${path}?${DAY_WINDOW}&class=chat&tz=Nope/X`));
  });

  test("llm", async () => {
    const path = "/v1/stats/llm";
    record("llm", await http("GET", `${path}?${DAY_WINDOW}`));
    record("llm.by-model", await http("GET", `${path}?${DAY_WINDOW}&group_by=model,flow`));
    record(
      "llm.filtered",
      await http("GET", `${path}?${DAY_WINDOW}&model=claude-haiku-4-5&flow=converse&result=error`),
    );
    record("llm.by-user", await http("GET", `${path}?${DAY_WINDOW}&group_by=user`));
    record("llm.by-conversation", await http("GET", `${path}?${DAY_WINDOW}&group_by=conversation`));
    record(
      "llm.group-too-many",
      await http("GET", `${path}?${DAY_WINDOW}&group_by=model,flow,result`),
    );
    record("llm.group-invalid", await http("GET", `${path}?${DAY_WINDOW}&group_by=nope`));
    record("llm.result-invalid", await http("GET", `${path}?${DAY_WINDOW}&result=maybe`));
    record(
      "llm.window-empty",
      await http("GET", `${path}?bucket=hour&from=2026-01-15&to=2026-01-14`),
    );
    record(
      "llm.reader.own",
      await http("GET", `${path}?${DAY_WINDOW}&group_by=model`, statsReaderKey),
    );
    record(
      "llm.reader.own-user",
      await http(
        "GET",
        `${path}?${DAY_WINDOW}&user_id=${statsReaderId}&group_by=user`,
        statsReaderKey,
      ),
    );
    record(
      "llm.reader.other-user",
      await http("GET", `${path}?${DAY_WINDOW}&user_id=${OTHER_USER_ID}`, statsReaderKey),
    );
    record(
      "llm.reader.by-user",
      await http("GET", `${path}?${DAY_WINDOW}&group_by=user`, statsReaderKey),
    );
  });

  test("operating figures", async () => {
    const path = "/v1/stats/operating-figures";
    const recent = await http("GET", path);
    record("operating-figures.default.status", recent.status);
    record(
      "operating-figures.window",
      await http(
        "GET",
        `${path}?from=${encodeURIComponent("2026-01-15T00:00:00.000Z")}&to=${encodeURIComponent("2026-01-16T00:00:00.000Z")}`,
      ),
    );
    record("operating-figures.bad-window", await http("GET", `${path}?window=1y`));
    record(
      "operating-figures.inverted",
      await http(
        "GET",
        `${path}?from=${encodeURIComponent("2026-01-16T00:00:00.000Z")}&to=${encodeURIComponent("2026-01-15T00:00:00.000Z")}`,
      ),
    );
    record("operating-figures.bad-from", await http("GET", `${path}?from=yesterday`));
  });

  test("quality", async () => {
    const path = "/v1/stats/quality";
    record("quality", await http("GET", `${path}?${DAY_WINDOW}`));
    record("quality.workflow", await http("GET", `${path}?${DAY_WINDOW}&workflow_id=${uuid()}`));
    record("quality.tz-invalid", await http("GET", `${path}?${DAY_WINDOW}&tz=Nope/X`));
  });

  test("permission is checked on every method", async () => {
    for (const path of PATHS) {
      for (const method of ["GET", "HEAD", "POST", "DELETE"]) {
        record(
          `denied.${method} ${path}`,
          await http(method, `/v1/stats/${path}?bucket=nope`, deniedKey),
        );
      }
      record(`allowed.POST ${path}`, await http("POST", `/v1/stats/${path}`));
    }
    const rows = await ctx.db
      .select({ action: auditLog.action, reason: auditLog.reason, metadata: auditLog.metadata })
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.result, "denied")));
    record("denied.audit", rows.map((row) => normalize(row)).sort());
  });

  test("the golden file has no stale entries", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });
});
