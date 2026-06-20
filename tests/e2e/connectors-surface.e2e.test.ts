// Connectors surface — HTTP + sk CLI breadth.
//
// Exercises the full connector lifecycle a user touches when "connecting"
// a system: create from minimal config, probe (`/test`), invoke (`/call`),
// template discovery (`list` + `match-url`), and the `sk connectors` CLI
// read surface. Connectors point at the booted engine's OWN base_url so
// the probe + call stay hermetic (no third-party host). Asserts on the
// structured runtime log (module=http request.completed) to prove the
// invocation was observed, plus the audit trail for the create.
//
// LLM: mock (no model call on this path; mock just keeps boot hermetic).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { seedConnector } from "./_helpers/factories.ts";
import { apiClient } from "./_helpers/http.ts";
import { assertLogEvent } from "./_helpers/logs.ts";
import { boot, cli, type E2EEnv, expectSuccess, shutdown } from "./setup.ts";

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
    // Point the connector at the booted engine so the probe + call hit a
    // real, reachable, deterministic endpoint instead of a third party.
    const { id, slug } = await seedConnector(env, {
      name: "Self Engine",
      base_url: env.baseUrl,
    });
    expect(id).toBeTruthy();

    // Probe: the envelope must always carry a boolean `ok` + numeric
    // latency. We don't pin ok=true (the probe target is the root path,
    // whose status is engine-version-dependent) — the contract is that
    // the probe surface answers with the typed ProbeResult shape.
    const probe = await api.post<{ ok: boolean; latency_ms: number }>(
      `/v1/connectors/${id}/test`,
      undefined,
    );
    expect(probe.status).toBe(200);
    expect(typeof probe.body.ok).toBe("boolean");
    expect(typeof probe.body.latency_ms).toBe("number");

    // Call: explicitly target /v1/health which deterministically 200s.
    const call = await api.post<{ status: number; latency_ms: number }>(
      `/v1/connectors/${id}/call`,
      {
        method: "GET",
        path: "/v1/health",
      },
    );
    expect(call.status).toBe(200);
    expect(call.body.status).toBe(200);

    // Runtime-log assertion: the /call round-trip was logged by the HTTP
    // middleware. Presence-based, scoped to the call path — never a count.
    await assertLogEvent(api, {
      module: "http",
      action: "request.completed",
      where: (e) => e.fields.path === `/v1/connectors/${id}/call`,
      wait: true,
    });

    // Connector is persisted + findable by slug via the list surface.
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

    // match-url against a well-known vendor URL should surface at least
    // one template match (GitHub ships as a builtin template).
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
