import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AuditAction } from "../../audit/index.ts";
import {
  auditLog,
  connectors,
  credentials,
  executions,
  llmUsage,
  outboundConnections,
} from "../../db/schema/index.ts";
import { createWorkflowRow } from "../../execution/tests/setup.ts";
import { currentMonthBucket } from "../../llm/accounting/index.ts";
import { invalidateAttention } from "../../operator/attention.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;

const FROM = "2026-01-10T00:00:00.000Z";
const TO = "2026-01-11T00:00:00.000Z";
const at = (iso: string) => new Date(iso);
const uuid = createDeterministicUuidFactory(0x51);

async function rest<T>(path: string): Promise<T> {
  const res = await fetch(`${suite.http.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${suite.http.apiKey}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

async function mcp<T>(name: string, args: Record<string, unknown> = {}, apiKey?: string) {
  const client = apiKey ? await suite.connectWithApiKey(apiKey) : await suite.connect();
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  expect(result.isError).not.toBe(true);
  return JSON.parse(content[0]?.text ?? "null") as T;
}

beforeAll(async () => {
  suite = await startMcpTestSuite("surface-parity");
  const db = suite.http.db;
  const tenant_id = suite.http.tenantId;

  const run = (status: "succeeded" | "failed" | "running", started: string) => ({
    tenant_id,
    status,
    source_kind: "draft" as const,
    request_source: "scheduler",
    execution_mode: "prod" as const,
    started_at: at(started),
    created_at: at(started),
  });
  await db
    .insert(executions)
    .values([
      run("succeeded", "2026-01-10T01:00:00.000Z"),
      run("succeeded", "2026-01-10T02:00:00.000Z"),
      run("failed", "2026-01-10T03:00:00.000Z"),
      run("running", "2026-01-10T03:30:00.000Z"),
      run("failed", "2026-01-09T23:00:00.000Z"),
    ]);

  const decision = (action: string, ts: string) => ({
    id: uuid(),
    tenant_id,
    actor_type: "user",
    action,
    resource_type: "patch_candidate",
    result: "success",
    ts: at(ts),
  });
  await db
    .insert(auditLog)
    .values([
      decision(AuditAction.PATCH_CANDIDATE_APPROVED, "2026-01-10T04:00:00.000Z"),
      decision(AuditAction.PATCH_CANDIDATE_AUTO_APPLIED, "2026-01-10T05:00:00.000Z"),
      decision(AuditAction.PATCH_CANDIDATE_REJECTED, "2026-01-10T06:00:00.000Z"),
      decision(AuditAction.PATCH_CANDIDATE_PROPOSED, "2026-01-10T07:00:00.000Z"),
      decision(AuditAction.PATCH_CANDIDATE_APPROVED, "2026-01-12T00:00:00.000Z"),
    ]);

  const healthy = await suite.seedConnector({ slug: "parity-ok" });
  const degraded = await suite.seedConnector({ slug: "parity-degraded" });
  const disabled = await suite.seedConnector({ slug: "parity-off" });
  const { eq } = await import("drizzle-orm");
  await db.update(connectors).set({ health_state: "ok" }).where(eq(connectors.id, healthy.id));
  await db
    .update(connectors)
    .set({ health_state: "degraded" })
    .where(eq(connectors.id, degraded.id));
  await db.update(connectors).set({ enabled: false }).where(eq(connectors.id, disabled.id));

  const call = (model: string, ts: string, user_id: string | null = suite.http.userId) => ({
    tenant_id,
    user_id,
    actor_type: user_id ? "user" : "system",
    flow: "chat",
    model,
    prompt_tokens: 12_000,
    completion_tokens: 3_000,
    cache_read_tokens: 2_000,
    cache_creation_tokens: 1_000,
    total_tokens: 12_000,
    result: "ok",
    month_bucket: 202601,
    created_at: at(ts),
  });
  await db
    .insert(llmUsage)
    .values([
      call("gpt-4.1-mini", "2026-01-10T08:00:00.000Z"),
      call("openai/gpt-4.1-mini-2025-04-14", "2026-01-10T09:00:00.000Z"),
      call("house-model-7", "2026-01-10T10:00:00.000Z"),
      call("gpt-5.6-sol", "2026-01-10T11:00:00.000Z", null),
    ]);

  const [connection] = await db
    .insert(outboundConnections)
    .values({
      tenant_id,
      name: "parity-wiki",
      base_url: "https://wiki.test",
      issuer: "https://wiki.test",
      authorization_endpoint: "https://wiki.test/authorize",
      token_endpoint: "https://wiki.test/token",
      client_id: "c",
      scopes: ["read", "offline_access"],
      granted_scopes: ["read", "offline_access"],
      access_token_version: 1,
      refresh_token_version: 1,
      expires_at: at("2026-01-10T12:00:00.000Z"),
    })
    .returning();
  if (!connection) throw new Error("connection fixture");
  await db.insert(credentials).values({
    tenant_id,
    connector_id: degraded.id,
    environment: "prod",
    mode: "oauth2",
    ciphertext: Buffer.from("x"),
    iv: Buffer.from("x"),
    auth_tag: Buffer.from("x"),
    connection_id: connection.id,
  });
});

afterAll(async () => {
  await suite.cleanup();
});

interface Figures {
  window: { from: string; to: string };
  runs: {
    total: number;
    succeeded: number;
    failed: number;
    finished: number;
    success_rate_percent: number | null;
  };
  connectors: {
    enabled: number;
    not_ok: number;
    needs_reauth: number;
    healthy_percent: number | null;
  };
  repairs: { decided: number; applied: number; applied_percent: number | null };
}

describe("operations figures of the Übersicht", () => {
  test("HTTP and MCP return the same figures for the same window", async () => {
    const q = `from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`;
    const http = await rest<Figures>(`/v1/stats/operating-figures?${q}`);
    const tool = await mcp<Figures>("get_operating_figures", { from: FROM, to: TO });
    expect(tool).toEqual(http);
    expect(http.runs).toMatchObject({
      total: 4,
      succeeded: 2,
      failed: 1,
      finished: 3,
      success_rate_percent: 67,
    });
    expect(http.repairs).toMatchObject({ decided: 3, applied: 2, applied_percent: 67 });
    expect(http.connectors.not_ok).toBeGreaterThanOrEqual(1);
  });

  test("the figures are the ones the cockpit composes from the raw stats routes", async () => {
    const q = `bucket=hour&from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`;
    const execs = await rest<{
      totals: { executions: { count: number; by_status: Record<string, number> } };
    }>(`/v1/stats/executions?${q}`);
    const events = await rest<{
      groups: Array<{ key: { action?: string }; totals: { calls: { total: number } } }>;
    }>(`/v1/stats/events?class=self_healing&group_by=action&${q}`);
    const enabled = await rest<{ total: number }>("/v1/connectors?enabled=true&limit=1");
    const notOk = await rest<{ total: number }>("/v1/connectors?health=not_ok&limit=1");

    const count = execs.totals.executions.count;
    const byStatus = execs.totals.executions.by_status as Record<string, number | undefined>;
    const succeeded = byStatus.succeeded ?? 0;
    const finished = count - (byStatus.queued ?? 0) - (byStatus.running ?? 0);
    const decided = [
      AuditAction.PATCH_CANDIDATE_APPROVED,
      AuditAction.PATCH_CANDIDATE_AUTO_APPLIED,
      AuditAction.PATCH_CANDIDATE_REJECTED,
    ] as string[];
    const applied = decided.slice(0, 2);
    const byAction = (actions: string[]) =>
      events.groups
        .filter((g) => actions.includes(g.key.action ?? ""))
        .reduce((sum, g) => sum + g.totals.calls.total, 0);

    const figures = await mcp<Figures>("get_operating_figures", { from: FROM, to: TO });
    expect(figures.runs.total).toBe(count);
    expect(figures.runs.success_rate_percent).toBe(Math.round((succeeded / finished) * 100));
    expect(figures.runs.success_rate_percent).toBe(67);
    expect(figures.repairs.decided).toBe(byAction(decided));
    expect(figures.repairs.applied).toBe(byAction(applied));
    expect(figures.connectors.enabled).toBe(enabled.total);
    expect(figures.connectors.not_ok).toBe(notOk.total);
  });

  test("list_executions takes the window and lists exactly the runs counted", async () => {
    const q = `started_from=${encodeURIComponent(FROM)}&started_to=${encodeURIComponent(TO)}`;
    const http = await rest<{ items: Array<{ id: string }>; total: number }>(
      `/v1/executions?${q}&limit=200`,
    );
    const tool = await mcp<{ items: Array<{ id: string }>; total: number }>("list_executions", {
      started_from: FROM,
      started_to: TO,
      limit: 200,
    });
    const figures = await mcp<Figures>("get_operating_figures", { from: FROM, to: TO });
    expect(tool.total).toBe(http.total);
    expect(tool.items.map((e) => e.id).sort()).toEqual(http.items.map((e) => e.id).sort());
    expect(tool.total).toBe(figures.runs.total);

    const failed = await mcp<{ total: number }>("list_executions", {
      started_from: FROM,
      started_to: TO,
      status: "failed",
    });
    expect(failed.total).toBe(figures.runs.failed);
  });
});

interface Cost {
  amount: number;
  currency: string;
  unpriced_models: string[];
  unpriced_calls: number;
  price_sources: Array<{ model: string; price_source: string }>;
}

describe("cost", () => {
  test("get_llm_usage prices a window exactly as GET /v1/stats/llm does", async () => {
    const userId = suite.http.userId;
    const q = `bucket=hour&from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&user_id=${userId}`;
    const http = await rest<{ cost: Cost }>(`/v1/stats/llm?${q}`);
    const tool = await mcp<{ cost: Cost; window: { from: string; to: string } }>("get_llm_usage", {
      from: FROM,
      to: TO,
      user_id: userId,
    });
    expect(tool.cost).toEqual(http.cost);
    expect(tool.window).toEqual({ from: FROM, to: TO });
    expect(http.cost.amount).toBeGreaterThan(0);
    expect(http.cost.unpriced_models).toEqual(["house-model-7"]);
    expect(http.cost.price_sources.every((s) => s.price_source === "catalog")).toBe(true);
    expect(http.cost.price_sources.map((s) => s.model).sort()).toEqual([
      "gpt-4.1-mini",
      "openai/gpt-4.1-mini-2025-04-14",
    ]);
  });
});

describe("monthly token budget", () => {
  test("GET /v1/status and get_token_budget report the same month, cap, room and state", async () => {
    const put = await fetch(
      `${suite.http.baseUrl}/v1/settings/tokens.monthly_budget?tenant=${suite.http.tenantId}`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${suite.http.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ value: 1000 }),
      },
    );
    expect(put.status).toBe(200);
    await suite.http.db.insert(llmUsage).values({
      tenant_id: suite.http.tenantId,
      flow: "chat",
      model: "gpt-4.1-mini",
      total_tokens: 896,
      result: "ok",
      month_bucket: currentMonthBucket(),
    });

    const status = await rest<{
      tokens_month: number;
      monthly_budget_tokens: number | null;
      remaining_monthly_budget_tokens: number | null;
      monthly_budget_state: string | null;
    }>("/v1/status");
    const tool = await mcp<{
      tenant: {
        used_tokens: number;
        budget_tokens: number | null;
        remaining_tokens: number | null;
        state: string | null;
      };
    }>("get_token_budget");
    expect(tool.tenant).toEqual({
      used_tokens: status.tokens_month,
      budget_tokens: status.monthly_budget_tokens,
      remaining_tokens: status.remaining_monthly_budget_tokens,
      state: status.monthly_budget_state,
    });
    expect(status.monthly_budget_state).toBe("tightening");

    invalidateAttention();
    const attention = await rest<{ items: Array<{ id: string }> }>("/v1/attention");
    expect(attention.items.some((item) => item.id === "budget")).toBe(false);
  });
});

describe("outbound connections", () => {
  test("list_connections returns the views GET /v1/connections returns", async () => {
    const http = await rest<{
      items: Array<{
        name: string;
        auto_renew: boolean;
        scopes: string[];
        granted_scopes: string[] | null;
        used_by: Array<{ slug: string }>;
      }>;
    }>("/v1/connections");
    const tool = await mcp<typeof http>("list_connections");
    expect(tool).toEqual(http);
    const wiki = http.items.find((item) => item.name === "parity-wiki");
    expect(wiki).toMatchObject({ auto_renew: true, scopes: ["read"], granted_scopes: ["read"] });
    expect(wiki?.used_by.map((user) => user.slug)).toEqual(["parity-degraded"]);
  });
});

describe("settings", () => {
  interface SettingsList {
    items: Array<{ path: string; value: unknown; meta: Record<string, unknown> }>;
    [key: string]: unknown;
  }

  test("subkit_settings returns the list GET /v1/settings returns", async () => {
    const { plaintext } = await suite.issueApiKey([
      "mcp:admin",
      "settings:read",
      "settings:read:global",
    ]);
    const http = await rest<SettingsList>("/v1/settings");
    const tool = await mcp<SettingsList>("subkit_settings", {}, plaintext);
    expect(tool).toEqual(http);
    const keyless = http.items.filter((item) => !Object.hasOwn(item, "value"));
    expect(keyless.map((item) => item.path)).toEqual([]);
    expect(http.items.some((item) => item.value === null)).toBe(true);
    expect(http.items.every((item) => typeof item.meta.requiresRestart === "boolean")).toBe(true);
  });

  test("one setting reads the same over both, restart semantics included", async () => {
    const { plaintext } = await suite.issueApiKey([
      "mcp:admin",
      "settings:read",
      "settings:read:global",
    ]);
    const http = await rest<SettingsList["items"][number]>("/v1/settings/server.port");
    const tool = await mcp<SettingsList>("subkit_settings", { path: "server.port" }, plaintext);
    expect(tool.items).toEqual([http]);
    expect(http.meta.requiresRestart).toBe(true);
  });
});

describe("apps", () => {
  interface AppList {
    items: Array<{ id: string; configured: boolean; workflow_count: number }>;
  }

  beforeAll(async () => {
    await createWorkflowRow(suite.http, {
      name: "parity-app-flow",
      slug: "parity-app-flow",
      product_id: "parity-app",
      steps: [{ id: "a", kind: "transform", expression: "return {};" }],
    });
  });

  test("list_apps returns the body GET /v1/apps returns", async () => {
    const { plaintext } = await suite.issueApiKey(["mcp:admin", "settings:read"]);
    const http = await rest<AppList>("/v1/apps");
    const tool = await mcp<AppList>("list_apps", {}, plaintext);
    expect(tool).toEqual(http);
    expect(http.items.find((item) => item.id === "parity-app")).toMatchObject({
      configured: false,
      workflow_count: 1,
    });
  });

  test("get_app returns the body GET /v1/apps/{id} returns", async () => {
    const { plaintext } = await suite.issueApiKey(["mcp:admin", "settings:read"]);
    const http = await rest<{ id: string; workflows: Array<{ slug: string }> }>(
      "/v1/apps/parity-app",
    );
    const tool = await mcp<typeof http>("get_app", { id: "parity-app" }, plaintext);
    expect(tool).toEqual(http);
    expect(http.workflows.map((workflow) => workflow.slug)).toEqual(["parity-app-flow"]);
  });

  test("get_app answers not_found for an app the workspace cannot see", async () => {
    const { plaintext } = await suite.issueApiKey(["mcp:admin", "settings:read"]);
    const client = await suite.connectWithApiKey(plaintext);
    const result = await client.callTool({ name: "get_app", arguments: { id: "parity-unseen" } });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text ?? "").toContain("not_found");
  });

  test("both tools are refused without settings:read", async () => {
    const { plaintext } = await suite.issueApiKey(["mcp:admin", "workflow:read"]);
    const client = await suite.connectWithApiKey(plaintext);
    for (const [name, args] of [
      ["list_apps", {}],
      ["get_app", { id: "parity-app" }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(JSON.parse(content[0]?.text ?? "{}")).toMatchObject({
        error_code: "policy_denied",
        details: { required: "settings:read" },
      });
    }
  });
});
