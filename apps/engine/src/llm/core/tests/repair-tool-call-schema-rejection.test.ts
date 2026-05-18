// Unit coverage for the schema-rejection detector that gates the
// `normalized_schema` attachment in the `repair_tool_call.failed`
// warn payload. Regression risk: the heuristic is purely string-based
// and would drift silently if a future provider changed its error
// message format. These tests pin the contract.

import { describe, expect, it } from "bun:test";
import { isSchemaRejectionError } from "../repair-tool-call.ts";

describe("isSchemaRejectionError", () => {
  it("fires on AI_APICallError by name", () => {
    expect(
      isSchemaRejectionError({
        errName: "AI_APICallError",
        errMsg: "some unrelated text",
      }),
    ).toBe(true);
  });

  it("fires on the Anthropic 'output_config.format.schema' marker", () => {
    expect(
      isSchemaRejectionError({
        errName: "Error",
        errMsg:
          "output_config.format.schema: For 'object' type, 'additionalProperties' must be explicitly set to false",
      }),
    ).toBe(true);
  });

  it("fires on 'Empty schema' (z.unknown() regression)", () => {
    expect(
      isSchemaRejectionError({
        errName: "Error",
        errMsg: "Empty schema ({}) that accepts any JSON value is not supported",
      }),
    ).toBe(true);
  });

  it("fires on 'Schema type' (oneOf rejection)", () => {
    expect(
      isSchemaRejectionError({
        errName: "Error",
        errMsg: "Schema type 'oneOf' is not supported",
      }),
    ).toBe(true);
  });

  it("does NOT fire on a generic network error", () => {
    expect(
      isSchemaRejectionError({
        errName: "FetchError",
        errMsg: "socket hang up",
      }),
    ).toBe(false);
  });

  it("does NOT fire on a quota error", () => {
    expect(
      isSchemaRejectionError({
        errName: "Error",
        errMsg: "quota exceeded for tenant",
      }),
    ).toBe(false);
  });
});
