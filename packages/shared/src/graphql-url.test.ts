import { describe, expect, test } from "bun:test";
import { looksLikeGraphQLUrl } from "./graphql-url.ts";

describe("looksLikeGraphQLUrl", () => {
  test("accepts canonical GraphQL endpoint paths case-insensitively", () => {
    expect(looksLikeGraphQLUrl("https://example.test/graphql")).toBe(true);
    expect(looksLikeGraphQLUrl("https://example.test/GraphQL/")).toBe(true);
    expect(looksLikeGraphQLUrl("https://example.test/api/graphql")).toBe(true);
    expect(looksLikeGraphQLUrl("https://example.test/graphql/v1")).toBe(true);
    expect(looksLikeGraphQLUrl("https://example.test/graphql/v42/")).toBe(true);
  });

  test("rejects look-alikes and invalid URLs", () => {
    expect(looksLikeGraphQLUrl("https://example.test/graphql/vx")).toBe(false);
    expect(looksLikeGraphQLUrl("https://example.test/graphql/schema")).toBe(false);
    expect(looksLikeGraphQLUrl("not a url")).toBe(false);
  });
});

test("trailing separators normalize, but version paths must match completely", () => {
  expect(looksLikeGraphQLUrl("https://example.test/graphql///")).toBe(true);
  for (const path of ["/nested/graphql/v1", "/graphql/v1extra", "/notgraphql", "/graphqlx"]) {
    expect(looksLikeGraphQLUrl(`https://example.test${path}`)).toBe(false);
  }
});
