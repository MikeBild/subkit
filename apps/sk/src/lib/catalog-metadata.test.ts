import { describe, expect, test } from "bun:test";
import { catalogMetadataBody } from "./catalog-metadata.ts";

describe("catalogMetadataBody", () => {
  test("sends only the flags that were given", () => {
    expect(catalogMetadataBody({})).toEqual({});
    expect(catalogMetadataBody({ category: "reports" })).toEqual({ category: "reports" });
  });

  test("keeps an empty string so the engine hands the field back to automation", () => {
    expect(catalogMetadataBody({ description: "", category: "" })).toEqual({
      description: "",
      category: "",
    });
  });
});
