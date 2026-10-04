// data_selector_error post-processing — when QuickJS throws "Cannot
// read property 'X' of undefined" because the LLM accessed
// `sourceData.<typo>`, attach `did_you_mean` candidates so the next
// retry can fix the typo without reading the docs.

import { describe, expect, test } from "bun:test";
import { LoopStepSchema } from "../../../workflows/types.ts";
import { runLoopStep } from "../loop.ts";

function ctx() {
  // Stub abort signal + the execution fields the data_selector path threads
  // into the sandbox clock (`started_at` / `execution_id`).
  return {
    signal: new AbortController().signal,
    started_at: new Date(1_700_000_000_000),
    execution_id: "00000000-0000-0000-0000-000000000099",
  } as unknown as Parameters<typeof runLoopStep>[0]["ctx"];
}

describe("loop · data_selector did_you_mean", () => {
  test("typo in the JS arg path → details.did_you_mean populated", async () => {
    const step = LoopStepSchema.parse({
      kind: "loop",
      id: "iter",
      // typo: fetch_projets vs. fetch_projects (the actual key)
      data_selector: "(s) => s.fetch_projets.data.projects",
      body: ["x"],
    });
    const scope = {
      fetch_projects: { data: { projects: [{ id: 1 }] } },
    };
    const result = await runLoopStep({ ctx: ctx(), step, scope });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("data_selector_error");
    const details = result.error?.details as Record<string, unknown>;
    expect(details.bad_key).toBe("data");
    // Levenshtein matches on the bad_key against the available
    // scope keys. `data` doesn't have a near-match in scope keys
    // here, so did_you_mean is empty in this case — but
    // `available_scope_keys` is always populated.
    expect(details.available_scope_keys).toContain("fetch_projects");
  });

  test("near-miss step id surfaces did_you_mean", async () => {
    const step = LoopStepSchema.parse({
      kind: "loop",
      id: "iter",
      // Force the QuickJS error to mention the step-id-typo path
      data_selector: "(s) => { const x = s.fetch_projets; return x.foo; }",
      body: ["x"],
    });
    const scope = {
      fetch_projects: { data: { projects: [] } },
    };
    const result = await runLoopStep({ ctx: ctx(), step, scope });
    expect(result.status).toBe("failed");
    const details = result.error?.details as Record<string, unknown>;
    expect(details.bad_key).toBe("foo");
    expect(details.available_scope_keys).toContain("fetch_projects");
  });
});
