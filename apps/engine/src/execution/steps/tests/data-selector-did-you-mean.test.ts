import { describe, expect, test } from "bun:test";
import { LoopStepSchema } from "../../../workflows/types.ts";
import { runLoopStep } from "../loop.ts";

function ctx() {
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
    expect(details.available_scope_keys).toContain("fetch_projects");
  });

  test("near-miss step id surfaces did_you_mean", async () => {
    const step = LoopStepSchema.parse({
      kind: "loop",
      id: "iter",
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
