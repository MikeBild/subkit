import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const spec = JSON.parse(
  readFileSync(
    join(import.meta.dir, "..", "..", "packages/cli-core/src/engine-api/openapi.json"),
    "utf8",
  ),
) as {
  components?: { schemas?: Record<string, { properties?: Record<string, unknown> }> };
};

describe("contract · ContextSnapshot.grounding_status", () => {
  const ctx = spec.components?.schemas?.ContextSnapshot;

  test("ContextSnapshot component exists", () => {
    expect(ctx).toBeDefined();
  });

  test("grounding_status is a nullable object with { state enum, advisory string|null }", () => {
    const gs = ctx?.properties?.grounding_status as
      | {
          type?: string | string[];
          properties?: {
            state?: { enum?: string[] };
            advisory?: { type?: string | string[] };
          };
          required?: string[];
        }
      | undefined;
    expect(gs).toBeDefined();
    expect(gs?.type).toEqual(["object", "null"]);
    expect(gs?.properties?.state?.enum).toEqual(["fresh", "stale", "unknown"]);
    expect(gs?.properties?.advisory?.type).toEqual(["string", "null"]);
    expect(gs?.required).toEqual(["state", "advisory"]);
  });
});
