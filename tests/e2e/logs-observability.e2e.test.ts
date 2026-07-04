// Observability surface — runtime log tail, trace correlation, redaction,
// tenant scoping, and the audit trail the tail itself writes.
//
// The diagnostics log tail (GET /v1/diagnostics/logs) is the cross-surface
// seam the rest of the e2e suites assert background work through. This file
// pins that seam's own contract: it returns structured entries, correlates
// a request's started/completed lines by trace_id, never leaks an API key
// plaintext (redaction), scopes entries to the caller's tenant, and writes
// a DIAGNOSTICS_LOGS_TAILED audit row on every read.
//
// LLM: none — boot mock to stay hermetic.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { seedWorkflow } from "./_helpers/factories.ts";
import { apiClient } from "./_helpers/http.ts";
import { getLogEntries } from "./_helpers/logs.ts";
import { boot, type E2EEnv, shutdown } from "./setup.ts";

let env: E2EEnv;
beforeAll(async () => {
  env = await boot("logs-observability", { llm: "mock" });
}, 90_000);
afterAll(async () => {
  await shutdown(env);
}, 30_000);

describe("diagnostics log tail", () => {
  test("returns structured http entries and correlates a request by trace_id", async () => {
    const api = apiClient(env);
    // Generate a deterministic, identifiable request.
    const { slug } = await seedWorkflow(env, { description: "trace probe" });
    expect(slug).toBeTruthy();

    const entries = await getLogEntries(api, { module: "http", limit: 500 });
    expect(entries.length).toBeGreaterThan(0);

    // Find a path that produced BOTH a started and a completed line, then
    // assert they share one trace_id — proving end-to-end correlation.
    const byPath = new Map<string, Set<string>>();
    for (const e of entries) {
      const path = e.fields.path as string | undefined;
      const trace = e.fields.trace_id as string | undefined;
      if (!path || !trace || (e.action !== "request.started" && e.action !== "request.completed")) {
        continue;
      }
      const key = `${path}::${trace}::${e.action}`;
      const set = byPath.get(`${path}::${trace}`) ?? new Set<string>();
      set.add(e.action);
      byPath.set(`${path}::${trace}`, set);
      void key;
    }
    const correlated = [...byPath.values()].some(
      (actions) => actions.has("request.started") && actions.has("request.completed"),
    );
    expect(correlated).toBe(true);
  }, 60_000);

  test("every returned entry is scoped to the caller's tenant (or system-scoped)", async () => {
    const api = apiClient(env);
    const entries = await getLogEntries(api, { limit: 500 });
    for (const e of entries) {
      const tenant = e.fields.tenant_id as string | null | undefined;
      // Entries either carry THIS tenant or are system-scoped (tenant_id
      // null/absent). They must never carry a different tenant's id.
      if (tenant !== undefined && tenant !== null) expect(tenant).toBe(env.tenantId);
    }
  }, 30_000);

  test("API key plaintext never appears in the log ring (redaction)", async () => {
    const api = apiClient(env);
    // Drive a few authenticated requests so the key is exercised.
    await api.get("/v1/connectors?limit=1");
    await api.get("/v1/workflows?limit=1");
    const entries = await getLogEntries(api, { limit: 1000 });
    const secret = env.personas.admin.apiKey;
    const leaked = entries.find((e) => JSON.stringify(e).includes(secret));
    expect(leaked).toBeUndefined();
  }, 30_000);

  test("reading the tail writes a diagnostics.logs_tailed audit row", async () => {
    const api = apiClient(env);
    await getLogEntries(api, { module: "http", limit: 10 });
    const audit = await api.get<unknown>("/v1/audit-log?limit=50");
    expect(audit.status).toBe(200);
    expect(JSON.stringify(audit.body)).toContain("diagnostics.logs_tailed");
  }, 30_000);
});
