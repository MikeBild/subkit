import { describe, expect, it } from "bun:test";
import { isSchemaRejectionError } from "../repair-tool-call.ts";

describe("isSchemaRejectionError", () => {
  it("fires on the Anthropic 'output_config.format.schema' marker", () => {
    expect(
      isSchemaRejectionError({
        errName: "AI_APICallError",
        errMsg:
          "output_config.format.schema: For 'object' type, 'additionalProperties' must be explicitly set to false",
      }),
    ).toBe(true);
  });

  it("fires on 'Empty schema' (z.unknown() regression)", () => {
    expect(
      isSchemaRejectionError({
        errName: "AI_APICallError",
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

  it("fires on a schema marker regardless of error name (covers provider wrappers)", () => {
    expect(
      isSchemaRejectionError({
        errName: "ProviderError",
        errMsg: "Empty schema is not supported by gateway",
      }),
    ).toBe(true);
  });

  it("does NOT fire on a generic AI_APICallError without a schema marker (quota / 429)", () => {
    expect(
      isSchemaRejectionError({
        errName: "AI_APICallError",
        errMsg: "quota exceeded for tenant",
      }),
    ).toBe(false);
    expect(
      isSchemaRejectionError({
        errName: "AI_APICallError",
        errMsg: "fetch failed: ECONNRESET",
      }),
    ).toBe(false);
    expect(
      isSchemaRejectionError({
        errName: "AI_APICallError",
        errMsg: "401 Unauthorized",
      }),
    ).toBe(false);
  });

  it("does NOT fire on a generic network error", () => {
    expect(
      isSchemaRejectionError({
        errName: "FetchError",
        errMsg: "socket hang up",
      }),
    ).toBe(false);
  });
});
