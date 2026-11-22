import { describe, expect, test } from "bun:test";
import { catalogMetadataBody, catalogMetadataCreate } from "./catalog-metadata.ts";

describe("catalogMetadataBody", () => {
  test("sends only the flags that were given", () => {
    expect(catalogMetadataBody({})).toEqual({});
    expect(catalogMetadataBody({ category: "reports" })).toEqual({ category: "reports" });
  });

  test("sends null for an empty string so the engine hands the field back to automation", () => {
    expect(catalogMetadataBody({ description: "", category: "" })).toEqual({
      description: null,
      category: null,
    });
  });
});

describe("catalogMetadataCreate", () => {
  test("sends the given flags and leaves empty ones to automation", () => {
    expect(catalogMetadataCreate({})).toEqual({});
    expect(catalogMetadataCreate({ description: "Sends reports", category: "reports" })).toEqual({
      description: "Sends reports",
      category: "reports",
    });
    expect(catalogMetadataCreate({ description: "", category: "" })).toEqual({});
  });
});
