import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { seedConnector } from "./_helpers/factories.ts";
import { apiClient } from "./_helpers/http.ts";
import { assertLogEvent } from "./_helpers/logs.ts";
import { boot, cli, type E2EEnv, expectSuccess, shutdown, writeTempFile } from "./setup.ts";

let env: E2EEnv;
beforeAll(async () => {
  env = await boot("connectors-surface", { llm: "mock" });
}, 90_000);
afterAll(async () => {
  await shutdown(env);
}, 30_000);

describe("connector create → probe → call (HTTP)", () => {
  test("create, /test probe, and /call against the engine's own health endpoint", async () => {
    const api = apiClient(env);
    const { id, slug } = await seedConnector(env, {
      name: "Self Engine",
      base_url: env.baseUrl,
    });
    expect(id).toBeTruthy();

    const probe = await api.post<{ ok: boolean; latency_ms: number }>(
      `/v1/connectors/${id}/test`,
      undefined,
    );
    expect(probe.status).toBe(200);
    expect(typeof probe.body.ok).toBe("boolean");
    expect(typeof probe.body.latency_ms).toBe("number");

    const call = await api.post<{ status: number; latency_ms: number }>(
      `/v1/connectors/${id}/call`,
      {
        method: "GET",
        path: "/health",
      },
    );
    expect(call.status).toBe(200);
    expect(call.body.status).toBe(200);

    await assertLogEvent(api, {
      module: "http",
      action: "request.completed",
      where: (e) => e.fields.path === `/v1/connectors/${id}/call`,
      wait: true,
    });

    const list = await api.get<{ items: Array<{ id: string; slug: string }> }>(
      "/v1/connectors?limit=100",
    );
    expect(list.status).toBe(200);
    expect(list.body.items.some((c) => c.slug === slug)).toBe(true);
  }, 60_000);
});

describe("connector templates (HTTP)", () => {
  test("templates list responds and match-url suggests a builtin for a known vendor", async () => {
    const api = apiClient(env);
    const list = await api.get<{ items?: unknown[] } | unknown[]>(
      "/v1/connector-templates?limit=10",
    );
    expect(list.status).toBe(200);

    const match = await api.get<{ matched: boolean; matches: Array<{ slug: string }> }>(
      "/v1/connector-templates/match-url?url=https%3A%2F%2Fapi.github.com%2Fuser%2Frepos",
    );
    expect(match.status).toBe(200);
    expect(Array.isArray(match.body.matches)).toBe(true);
  }, 30_000);
});

describe("sk connectors CLI read surface", () => {
  test("sk connectors list surfaces a seeded connector", async () => {
    const { slug } = await seedConnector(env, { name: "CLI Visible" });
    const result = await cli(["connectors", "list"], { env, persona: "admin" });
    expectSuccess(result, "sk connectors list");
    expect(result.stdout).toContain(slug);
  }, 60_000);
});

describe("sk connectors declarative authoring", () => {
  test("validate rejects a bad definition and reports the field", async () => {
    const file = writeTempFile(
      env.personas.admin,
      "bad-connector.json",
      JSON.stringify({ name: "Bad S3", driver: "s3", config: { region: "eu-central-1" } }),
    );
    const result = await cli(["connectors", "validate", file], { env, persona: "admin" });
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("bucket");
  }, 60_000);

  test("validate accepts a good definition", async () => {
    const file = writeTempFile(
      env.personas.admin,
      "good-connector.json",
      JSON.stringify({
        name: "Self Engine Declarative",
        driver: "http",
        base_url: env.baseUrl,
        config: {},
      }),
    );
    const result = await cli(["connectors", "validate", file], { env, persona: "admin" });
    expectSuccess(result, "sk connectors validate");
  }, 60_000);

  test("probe --file reaches the upstream without creating anything", async () => {
    const before = await cli(["connectors", "list", "--json"], { env, persona: "admin" });
    const file = writeTempFile(
      env.personas.admin,
      "probe-connector.json",
      JSON.stringify({
        name: "Probe Only",
        driver: "http",
        base_url: env.baseUrl,
        config: {},
      }),
    );
    const result = await cli(["connectors", "probe", "--file", file, "--json"], {
      env,
      persona: "admin",
    });
    expect(result.stdout).toContain("latency_ms");

    const after = await cli(["connectors", "list", "--json"], { env, persona: "admin" });
    expect(after.stdout.length).toBe(before.stdout.length);
  }, 90_000);

  test("create --file runs the checks, then saves", async () => {
    const file = writeTempFile(
      env.personas.admin,
      "create-connector.json",
      JSON.stringify({
        name: "Declarative Create",
        slug: "declarative-create",
        driver: "http",
        base_url: env.baseUrl,
        config: {},
      }),
    );
    const result = await cli(["connectors", "create", "--file", file, "--json"], {
      env,
      persona: "admin",
    });
    expectSuccess(result, "sk connectors create --file");

    const listed = await cli(["connectors", "list"], { env, persona: "admin" });
    expect(listed.stdout).toContain("declarative-create");
  }, 90_000);

  test("create --file refuses to save a definition that does not validate", async () => {
    const file = writeTempFile(
      env.personas.admin,
      "create-bad-connector.json",
      JSON.stringify({ name: "Never Saved", slug: "never-saved", driver: "s3", config: {} }),
    );
    const result = await cli(["connectors", "create", "--file", file], {
      env,
      persona: "admin",
    });
    expect(result.exitCode).not.toBe(0);

    const listed = await cli(["connectors", "list"], { env, persona: "admin" });
    expect(listed.stdout).not.toContain("never-saved");
  }, 90_000);

  test("a disabled connector is refused by probe, and the operator is told why", async () => {
    const { id } = await seedConnector(env, { name: "Switched Off", base_url: env.baseUrl });
    const api = apiClient(env);
    expect((await api.post(`/v1/connectors/${id}/disable`, undefined)).status).toBe(200);

    const probe = await cli(["connectors", "probe", id], { env, persona: "admin" });
    expect(probe.exitCode).not.toBe(0);
    expect(probe.stdout).toContain("connector_disabled");

    const tested = await cli(["connectors", "test", id], { env, persona: "admin" });
    expect(tested.exitCode).toBe(probe.exitCode);
    expect(tested.stdout).toContain("connector_disabled");
  }, 90_000);
});

describe("sk connectors driver-dispatched verbs", () => {
  test("disable then enable round-trips, and the bit is readable back", async () => {
    const { id } = await seedConnector(env, { name: "Switchable", base_url: env.baseUrl });

    const disabled = await cli(["connectors", "disable", id], { env, persona: "admin" });
    expectSuccess(disabled, "sk connectors disable");
    expect(JSON.parse(disabled.stdout).enabled).toBe(false);

    const afterDisable = await cli(["connectors", "get", id], { env, persona: "admin" });
    expect(JSON.parse(afterDisable.stdout).enabled).toBe(false);

    const enabled = await cli(["connectors", "enable", id], { env, persona: "admin" });
    expectSuccess(enabled, "sk connectors enable");
    expect(JSON.parse(enabled.stdout).enabled).toBe(true);
  }, 90_000);

  test("mcp-inspect on a connector of another driver fails with the engine's answer", async () => {
    const { id } = await seedConnector(env, { name: "Not An MCP Server" });
    const result = await cli(["connectors", "mcp-inspect", id], { env, persona: "admin" });
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("mcp connector");
  }, 60_000);

  test("mcp-authorize on a connector of another driver prints no URL", async () => {
    const { id } = await seedConnector(env, { name: "Not An MCP Server Either" });
    const result = await cli(["connectors", "mcp-authorize", id], { env, persona: "admin" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("http");
  }, 60_000);
});
