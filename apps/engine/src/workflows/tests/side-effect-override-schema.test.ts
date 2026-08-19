import { describe, expect, test } from "bun:test";
import { RequestStepSchema } from "../types.ts";

const CONNECTOR_ID = "11111111-2222-4333-8444-555555555555";

describe("RequestStepSchema side-effect downgrade guard", () => {
  test.each([["PUT"], ["PATCH"], ["DELETE"]] as const)("%s cannot be declared read", (method) => {
    const result = RequestStepSchema.safeParse({
      id: "write",
      kind: "request",
      connector_id: CONNECTOR_ID,
      method,
      path: "objects/a.json",
      side_effects: "read",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["side_effects"],
          message: `side_effects:"read" cannot downgrade mutating method ${method}`,
        }),
      );
    }
  });

  test("read-only POST remains an explicit supported override", () => {
    expect(
      RequestStepSchema.safeParse({
        id: "search",
        kind: "request",
        connector_id: CONNECTOR_ID,
        method: "POST",
        path: "search",
        side_effects: "read",
      }).success,
    ).toBe(true);
  });
});
