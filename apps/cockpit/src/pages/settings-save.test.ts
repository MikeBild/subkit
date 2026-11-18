import { afterEach, describe, expect, test } from "bun:test";
import type { SettingsPatch } from "@/pages/settings-model";
import {
  applySettingsPatch,
  saveSetting,
  settingsReadQuery,
  settleSettings,
} from "@/pages/settings-save";

const originalFetch = globalThis.fetch;
const tenant = "5870ae6d-e542-48ca-bbcc-108b5ae73f5f";

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function recordCalls(failOnPatch?: number) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  let revision = 7;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://cockpit.test").pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ method, path, body });
    if (method === "PATCH") {
      const patchIndex = calls.filter((call) => call.method === "PATCH").length;
      if (patchIndex === failOnPatch)
        return Response.json({ code: "validation_failed", message: "no" }, { status: 422 });
      revision += 1;
      return Response.json({ saved_revision: revision });
    }
    return Response.json({ activation_status: "active" });
  }) as typeof fetch;
  return calls;
}

const patch: SettingsPatch = {
  expected_revision: 7,
  scope: "tenant",
  tenant_id: tenant,
  changes: { "tokens.monthly_budget": 500 },
};

describe("saving settings", () => {
  test("one save is one patch and activates exactly the revision it saved", async () => {
    const calls = recordCalls();
    await applySettingsPatch(patch);
    expect(calls.map((call) => [call.method, call.path])).toEqual([
      ["PATCH", "/v1/settings"],
      ["POST", "/v1/settings/revisions/8/activate"],
    ]);
    expect(calls[0]?.body).toEqual(patch);
  });

  test("a failed patch activates nothing and leaves no second patch behind", async () => {
    const calls = recordCalls(1);
    await expect(applySettingsPatch(patch)).rejects.toMatchObject({ status: 422 });
    expect(calls.map((call) => call.method)).toEqual(["PATCH"]);
  });
});

describe("after a save", () => {
  const item = (path: string, value: unknown, meta: Record<string, unknown> = {}) => ({
    path,
    value,
    meta: {
      source: "tenant",
      scope: "tenant",
      sensitive: false,
      requiresRestart: false,
      kind: "number",
      ...meta,
    },
  });
  const response = (value: unknown) => ({
    saved_revision: 18,
    active_revision: 18,
    activation_status: "active" as const,
    pending_restart_fields: [],
    items: [
      item("tokens.monthly_budget", value),
      item("llm.api_key", "***", { sensitive: true, kind: "string" }),
      item("server.port", 3000, { requiresRestart: true, scope: "global" }),
    ],
    diagnostics: { pending_restart_keys: [], override_keys: [] },
  });

  test("waits until the read settings carry the saved value", async () => {
    const reads = [response(442268), response(442268), response(10000000)];
    let count = 0;
    const settled = await settleSettings(
      async () => reads[Math.min(count++, reads.length - 1)]!,
      { "tokens.monthly_budget": 10000000, "llm.api_key": "secret://x/1", "server.port": 4000 },
      { delayMs: 0 },
    );
    expect(count).toBe(3);
    expect(settled?.items[0]?.value).toBe(10000000);
  });

  test("gives up after its attempts instead of waiting forever", async () => {
    let count = 0;
    const settled = await settleSettings(
      async () => {
        count += 1;
        return response(442268);
      },
      { "tokens.monthly_budget": 10000000 },
      { attempts: 3, delayMs: 0 },
    );
    expect(settled).toBeNull();
    expect(count).toBe(3);
  });

  test("reads back the scope it saved", () => {
    expect(settingsReadQuery(patch)).toEqual({ tenant });
    expect(settingsReadQuery({ expected_revision: 1, scope: "global", changes: {} })).toEqual({});
  });
});

describe("saving one setting", () => {
  function recordUrls() {
    const urls: { method: string; url: URL; body: unknown }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push({
        method: (init?.method ?? "GET").toUpperCase(),
        url: new URL(String(input), "http://cockpit.test"),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      return Response.json({ value: 500, requiresRestart: false });
    }) as typeof fetch;
    return urls;
  }

  test("for one workspace names that workspace", async () => {
    const urls = recordUrls();
    await saveSetting("tokens.monthly_budget", tenant, 500);
    expect(urls).toHaveLength(1);
    expect(urls[0]?.method).toBe("PUT");
    expect(urls[0]?.url.pathname.endsWith("/v1/settings/tokens.monthly_budget")).toBe(true);
    expect(urls[0]?.url.searchParams.get("tenant")).toBe(tenant);
    expect(urls[0]?.body).toEqual({ value: 500 });
  });

  test("for all workspaces names none", async () => {
    const urls = recordUrls();
    await saveSetting("tokens.currency", null, "EUR");
    expect(urls[0]?.url.searchParams.has("tenant")).toBe(false);
    expect(urls[0]?.body).toEqual({ value: "EUR" });
  });
});
