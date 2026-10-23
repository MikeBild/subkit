import { afterEach, describe, expect, test } from "bun:test";
import type { SettingsPatch } from "@/pages/settings-model";
import { applySettingsPatches } from "@/pages/settings-save";

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

const patches: SettingsPatch[] = [
  { expected_revision: 7, scope: "global", changes: { "log.level": "debug" } },
  {
    expected_revision: 7,
    scope: "tenant",
    tenant_id: tenant,
    changes: { "tokens.monthly_budget": 500 },
  },
];

describe("saving settings in both scopes", () => {
  test("chains the revision and activates only the last one", async () => {
    const calls = recordCalls();
    await applySettingsPatches(patches);
    expect(calls.map((call) => [call.method, call.path])).toEqual([
      ["PATCH", "/v1/settings"],
      ["PATCH", "/v1/settings"],
      ["POST", "/v1/settings/revisions/9/activate"],
    ]);
    expect(calls[0]?.body).toMatchObject({ expected_revision: 7, scope: "global" });
    expect(calls[1]?.body).toMatchObject({
      expected_revision: 8,
      scope: "tenant",
      tenant_id: tenant,
    });
  });

  test("a failed second patch activates nothing", async () => {
    const calls = recordCalls(2);
    await expect(applySettingsPatches(patches)).rejects.toMatchObject({ status: 422 });
    expect(calls.filter((call) => call.method === "POST")).toEqual([]);
  });

  test("one patch is saved and activated once", async () => {
    const calls = recordCalls();
    await applySettingsPatches(patches.slice(0, 1));
    expect(calls.map((call) => call.method)).toEqual(["PATCH", "POST"]);
  });
});
