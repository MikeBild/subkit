import { afterEach, describe, expect, test } from "bun:test";
import type { SettingsPatch } from "@/pages/settings-model";
import { applySettingsPatch } from "@/pages/settings-save";

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
