// Contract: the /v1/conversations/{id}/context-snapshot response carries a
// `grounding_status` advisory field with a stable shape. This is a REAL
// OpenAPI contract — grounding_status is a property of the ContextSnapshot
// component referenced by a live route — so a refactor that drops or
// renames it fails here (and via check:openapi-drift) rather than silently.
//
// Pinned against the committed client spec (the same source of truth
// client-contract.test.ts uses); `bun run check:openapi-drift` guards that
// this file stays in sync with the engine's Zod schema.

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
          type?: string;
          nullable?: boolean;
          properties?: {
            state?: { enum?: string[] };
            advisory?: { type?: string; nullable?: boolean };
          };
          required?: string[];
        }
      | undefined;
    expect(gs).toBeDefined();
    expect(gs?.nullable).toBe(true);
    expect(gs?.properties?.state?.enum).toEqual(["fresh", "stale", "unknown"]);
    expect(gs?.properties?.advisory?.nullable).toBe(true);
    expect(gs?.required).toEqual(["state", "advisory"]);
  });
});
