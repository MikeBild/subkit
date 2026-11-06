import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { getConfig } from "../../../config/loader.ts";
import { auditLog, users } from "../../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../http/tests/setup.ts";
import { createDeterministicHexFactory } from "../../../test-helpers/determinism/ids.ts";
import { emptyRoleId } from "../../../test-helpers/roles.ts";
import { now } from "../../../utils/clock.ts";

const GOLDEN_PATH = new URL("./fixtures/stats-usage.golden.json", import.meta.url).pathname;
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, string>;
const actual: Record<string, string> = {};
const DAY = 86_400_000;
const SURFACES = ["http", "chat", "mcp", "conversations"] as const;

let ctx: HttpTestServer;
let deniedKey: string;

function normalize(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll(ctx.tenantId, "<tenant>")
    .replace(/"20(2[4-9]|[3-9]\d)-\d\d-\d\dT[\d:.]+Z"/g, '"<time>"')
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
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function today(): number {
  return Math.floor(now() / DAY) * DAY;
}

function window(fromMs: number, toMs: number, extra = ""): string {
  return `bucket=day&from=${encodeURIComponent(iso(fromMs))}&to=${encodeURIComponent(iso(toMs))}${extra}`;
}

beforeAll(async () => {
  ctx = await createHttpTestServer("operations_stats_usage_golden");
  const [denied] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "denied-stats-usage@test.local",
      role_id: await emptyRoleId(ctx.db, ctx.tenantId),
    })
    .returning();
  if (!denied) throw new Error("denied user insert returned no row");
  deniedKey = `wf_live_${createDeterministicHexFactory(0x57_a7)(16)}`;
  await ctx.testDb.pool.query(
    "INSERT INTO subkit.api_keys (tenant_id, user_id, prefix, token_sha256, scopes) VALUES ($1, $2, $3, $4, $5::jsonb)",
    [
      ctx.tenantId,
      denied.id,
      deniedKey.slice(0, 12),
      createHash("sha256").update(deniedKey).digest("hex"),
      JSON.stringify(["*"]),
    ],
  );
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
});

describe("usage stats routes keep their HTTP responses byte for byte", () => {
  test("every surface answers its report", async () => {
    const recent = window(today() - 2 * DAY, today());
    for (const surface of SURFACES) {
      record(`http.${surface}`, await http("GET", `/v1/stats/${surface}?${recent}`));
      record(
        `http.${surface}.invalid-traffic`,
        await http("GET", `/v1/stats/${surface}?${recent}&traffic_class=bogus`),
      );
    }
  });

  test("windows, traffic classes and groupings are validated", async () => {
    const retention = getConfig().observability.usage.retention_days;
    const recent = window(today() - 2 * DAY, today());
    const path = "/v1/stats/http";
    record(
      "http.truncated",
      await http("GET", `${path}?${window(today() - (retention + 5) * DAY, today())}`),
    );
    record(
      "http.before-horizon",
      await http(
        "GET",
        `${path}?${window(today() - (retention + 10) * DAY, today() - (retention + 5) * DAY)}`,
      ),
    );
    record("http.window-empty", await http("GET", `${path}?${window(today(), today() - DAY)}`));
    record("http.missing-bucket", await http("GET", `${path}?from=${iso(today())}`));
    record(
      "http.grouped",
      await http(
        "GET",
        `${path}?${recent}&group_by=operation,outcome&traffic_class=organic,synthetic`,
      ),
    );
    record(
      "http.group-too-many",
      await http("GET", `${path}?${recent}&group_by=operation,outcome,platform`),
    );
    record("http.group-invalid", await http("GET", `${path}?${recent}&group_by=nope`));
  });

  test("permission is checked on every method", async () => {
    for (const surface of SURFACES) {
      for (const method of ["GET", "HEAD", "POST"]) {
        record(
          `http.denied.${method} ${surface}`,
          await http(method, `/v1/stats/${surface}?bucket=nope`, deniedKey),
        );
      }
    }
    const rows = await ctx.db
      .select({ action: auditLog.action, reason: auditLog.reason })
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.result, "denied")));
    record("http.denied.audit", rows.map((row) => normalize(row)).sort());
  });

  test("the golden file has no stale entries", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });
});
