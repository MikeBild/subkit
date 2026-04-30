// Structural lint: every conversation tool's `inputSchema` MUST
// serialise to a JSON Schema with `type: "object"` at the root. This
// is what Anthropic's tool-use endpoint requires; a Zod union /
// discriminatedUnion / primitive at the root produces `anyOf` with
// no top-level `type` and the API rejects the entire turn with
// `tools.N.custom.input_schema.type: Field required`.
//
// Pre-fix the wave-3 rewrite of `test_rbac_expression` switched its
// input from `z.object(...)` to `z.union([...])`, which built fine,
// typechecked fine, and unit-tested fine — but blew up the very
// first live LLM turn that loaded the full tool palette. This test
// pins the contract so a future regression is caught at `bun test`
// time.

import { describe, expect, test } from "bun:test";
import { z } from "@hono/zod-openapi";
import { listTools } from "../tools/index.ts";

function toJsonSchema(schema: unknown): Record<string, unknown> {
  // biome-ignore lint/suspicious/noExplicitAny: zod v4 surface
  return (z as any).toJSONSchema(schema, { target: "jsonSchema7" });
}

describe("conversation tools — input schema shape", () => {
  const tools = listTools();
  for (const tool of tools) {
    test(`${tool.name} → input_schema.type === "object"`, () => {
      const json = toJsonSchema(tool.inputSchema);
      // Anthropic accepts ONLY `type: "object"` at the root. A
      // `oneOf` / `anyOf` at the root (from a Zod union) is what
      // the wave-3 regression produced — explicitly reject it.
      expect(json.type).toBe("object");
      expect(json.anyOf).toBeUndefined();
      expect(json.oneOf).toBeUndefined();
    });
  }
});
