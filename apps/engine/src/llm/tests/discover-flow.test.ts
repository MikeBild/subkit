// discover flow integration test — goes through the mock provider so
// no testcontainer / real network is required.

import { beforeEach, describe, expect, it } from "bun:test";

import { runDiscoverFlow } from "../flows/discover.ts";
import { resetMockProvider } from "../mock-provider.ts";
import { createLlmTestCtx, type LlmTestCtx } from "./setup.ts";

describe("discover flow (mock provider)", () => {
  let ctx: LlmTestCtx;

  beforeEach(async () => {
    ctx = await createLlmTestCtx("discover");
    resetMockProvider();
  });

  it("returns the canned mock envelope with at least one artifact", async () => {
    const result = await runDiscoverFlow(
      {
        tenant_id: ctx.tenant_id,
        run_id: "test-run-1",
        files: {
          "api-spec.yaml": "openapi: 3.0.0\ninfo:\n  title: ACME\n  version: 1.0",
        },
      },
      ctx.testDb.db,
    );

    expect(result.artifacts.length).toBeGreaterThanOrEqual(1);
    expect(result.artifacts[0]?.kind).toBe("connector");
    expect(result.artifacts[0]?.confidence).toBeGreaterThan(0);
    expect(result.model_used).toBeTruthy();
    await ctx.cleanup();
  });
});
