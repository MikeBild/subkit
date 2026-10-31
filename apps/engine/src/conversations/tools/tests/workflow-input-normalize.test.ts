import { describe, expect, test } from "bun:test";
import { structuredInputFields } from "../workflow-input-normalize.ts";

describe("structuredInputFields", () => {
  const properties = {
    description: { type: "string" },
    parts: { type: "array" },
    manifest: { type: "object" },
    tags: { type: ["array", "null"] },
  };

  test("names array and object fields among the given names", () => {
    expect(structuredInputFields(properties, ["description", "parts", "manifest", "tags"])).toEqual(
      ["parts", "manifest", "tags"],
    );
  });

  test("returns nothing without a property map or for scalar fields", () => {
    expect(structuredInputFields(undefined, ["parts"])).toEqual([]);
    expect(structuredInputFields({ parts: { type: "string" } }, ["parts"])).toEqual([]);
    expect(structuredInputFields(properties, ["unknown"])).toEqual([]);
  });
});
