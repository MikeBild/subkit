import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { setConfigKey } from "../../config/loader.ts";
import { tenants, usageEvents } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;
const FROM = "2026-07-19T00:00:00.000Z";
const TO = "2026-07-20T00:00:00.000Z";
const WINDOW = `bucket=hour&from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`;

beforeAll(async () => {
  srv = await createHttpTestServer("stats-usage");
  await setConfigKey("observability.usage.hmac_secret", "u".repeat(32), { force: true });
  await setConfigKey("observability.usage.enabled", true, { force: true });
  const [foreignTenant] = await srv.db
    .insert(tenants)
    .values({ slug: "stats-usage-foreign", display_name: "Foreign usage tenant" })
    .returning({ id: tenants.id });
  if (!foreignTenant) throw new Error("foreign tenant seed failed");
  await srv.db.insert(usageEvents).values([
    {
      tenant_id: srv.tenantId,
      surface: "http",
      operation: "/v1/workflows",
      method: "GET",
      outcome: "success",
      traffic_class: "organic",
      request_source: "api",
      actor_hmac: "actor-a",
      session_hmac: "session-a",
      duration_ms: 10,
      request_bytes: 5,
      response_bytes: 100,
      stream_outcome: "not_streamed",
      response_mode: "json",
      created_at: sql`${FROM}::timestamptz`,
    },
    {
      tenant_id: srv.tenantId,
      surface: "http",
      operation: "/v1/workflows",
      method: "GET",
      outcome: "success",
      traffic_class: "organic",
      request_source: "api",
      actor_hmac: "actor-a",
      session_hmac: "session-b",
      duration_ms: 20,
      request_bytes: 5,
      response_bytes: 200,
      stream_outcome: "not_streamed",
      response_mode: "json",
      created_at: sql`'2026-07-19T01:00:00.000Z'::timestamptz`,
    },
    {
      tenant_id: srv.tenantId,
      surface: "http",
      operation: "/v1/executions",
      method: "POST",
      outcome: "server_error",
      traffic_class: "organic",
      request_source: "api",
      actor_hmac: "actor-b",
      session_hmac: "session-b",
      duration_ms: 30,
      request_bytes: 10,
      response_bytes: 50,
      response_mode: "json",
      created_at: sql`'2026-07-19T02:00:00.000Z'::timestamptz`,
    },
    {
      tenant_id: srv.tenantId,
      surface: "http",
      operation: "/v1/workflows",
      method: "GET",
      outcome: "success",
      traffic_class: "synthetic",
      request_source: "api",
      actor_hmac: "canary",
      session_hmac: "canary-session",
      duration_ms: 5,
      response_mode: "json",
      created_at: sql`'2026-07-19T03:00:00.000Z'::timestamptz`,
    },
    {
      tenant_id: srv.tenantId,
      surface: "mcp",
      operation: "session/initialized",
      method: "POST",
      outcome: "success",
      traffic_class: "organic",
      request_source: "mcp",
      actor_hmac: "actor-a",
      session_hmac: "mcp-session",
      response_mode: "sse",
      active_sessions: 4,
      created_at: sql`'2026-07-19T04:00:00.000Z'::timestamptz`,
    },
    {
      tenant_id: srv.tenantId,
      surface: "mcp",
      operation: "session/closed",
      method: "DELETE",
      outcome: "success",
      traffic_class: "organic",
      request_source: "mcp",
      actor_hmac: "actor-a",
      session_hmac: "mcp-session",
      response_mode: "none",
      active_sessions: 3,
      created_at: sql`'2026-07-19T05:00:00.000Z'::timestamptz`,
    },
    {
      tenant_id: foreignTenant.id,
      surface: "http",
      operation: "/v1/workflows",
      method: "GET",
      outcome: "success",
      traffic_class: "organic",
      request_source: "api",
      actor_hmac: "foreign-actor",
      session_hmac: "foreign-session",
      duration_ms: 999,
      response_mode: "json",
      created_at: sql`'2026-07-19T06:00:00.000Z'::timestamptz`,
    },
  ]);
});

afterAll(async () => {
  await setConfigKey("observability.usage.enabled", false, { force: true });
  await srv.cleanup();
});

function authed(path: string): Promise<Response> {
  return fetch(`${srv.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${srv.apiKey}` },
  });
}

describe("semantic usage stats", () => {
  test("defaults organic and computes exact window uniques plus ratio evidence", async () => {
    const res = await authed(`/v1/stats/http?${WINDOW}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      schema_version: string;
      traffic_class: string[];
      totals: {
        calls: number;
        unique_actors: number;
        unique_sessions: number;
        bytes: { request: number; response: number };
        success_ratio: { numerator: number; denominator: number; value: number };
      };
      semantic: { value_state: string };
      quality: { sampled: boolean; unique_scope: string; content_captured: boolean };
    };
    expect(body.schema_version).toBe("subkit.usage-stats.v1");
    expect(body.traffic_class).toEqual(["organic"]);
    expect(body.totals.calls).toBe(3);
    expect(body.totals.unique_actors).toBe(2);
    expect(body.totals.unique_sessions).toBe(2);
    expect(body.totals.bytes).toEqual({ request: 20, response: 350 });
    expect(body.totals.success_ratio).toEqual({
      numerator: 2,
      denominator: 3,
      value: 2 / 3,
    });
    expect(body.semantic.value_state).toBe("measured");
    expect(body.quality).toMatchObject({
      sampled: false,
      unique_scope: "exact_window",
      content_captured: false,
    });
  });

  test("synthetic canaries are independently selectable", async () => {
    const res = await authed(`/v1/stats/http?${WINDOW}&traffic_class=synthetic`);
    const body = (await res.json()) as { totals: { calls: number } };
    expect(body.totals.calls).toBe(1);
  });

  test("grouping is bounded to two controlled dimensions", async () => {
    const grouped = await authed(`/v1/stats/http?${WINDOW}&group_by=operation,outcome`);
    expect(grouped.status).toBe(200);
    const body = (await grouped.json()) as { groups: Array<{ key: Record<string, string> }> };
    expect(body.groups.some((group) => group.key.operation === "/v1/workflows")).toBe(true);
    const rejected = await authed(`/v1/stats/http?${WINDOW}&group_by=operation,outcome,platform`);
    expect(rejected.status).toBe(400);
  });

  test("MCP surface exposes connection and capacity details", async () => {
    const res = await authed(`/v1/stats/mcp?${WINDOW}`);
    const body = (await res.json()) as {
      totals: {
        calls: number;
        surface_details: {
          sessions_initialized: number;
          sessions_closed: number;
          active_sessions_peak: number;
        };
      };
    };
    expect(body.totals.calls).toBe(2);
    expect(body.totals.surface_details).toMatchObject({
      sessions_initialized: 1,
      sessions_closed: 1,
      active_sessions_peak: 4,
    });
  });
});
