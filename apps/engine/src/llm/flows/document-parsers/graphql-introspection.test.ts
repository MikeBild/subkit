import { describe, expect, test } from "bun:test";
import { buildSchema, introspectionFromSchema } from "graphql";
import { parseGraphQLIntrospection } from "./graphql-introspection.ts";

const MINIMAL_SCHEMA = buildSchema(`
  type Query {
    hero(id: ID): Hero
    heroes: [Hero]
  }
  type Mutation {
    createHero(name: String!): Hero
  }
  type Hero {
    id: ID
    name: String
  }
`);

const MINIMAL_INTROSPECTION_JSON = JSON.stringify({
  data: introspectionFromSchema(MINIMAL_SCHEMA),
});

describe("parseGraphQLIntrospection", () => {
  test("returns endpoints for Query fields", () => {
    const endpoints = parseGraphQLIntrospection(MINIMAL_INTROSPECTION_JSON);
    const queryPaths = endpoints.filter((e) => e.path.includes("Query."));
    expect(queryPaths.length).toBeGreaterThanOrEqual(2);
  });

  test("returns endpoints for Mutation fields", () => {
    const endpoints = parseGraphQLIntrospection(MINIMAL_INTROSPECTION_JSON);
    const mutationPaths = endpoints.filter((e) => e.path.includes("Mutation."));
    expect(mutationPaths.length).toBeGreaterThanOrEqual(1);
  });

  test("Query endpoints have method POST", () => {
    const endpoints = parseGraphQLIntrospection(MINIMAL_INTROSPECTION_JSON);
    for (const ep of endpoints.filter((e) => e.path.includes("Query."))) {
      expect(ep.method).toBe("POST");
    }
  });

  test("Query endpoints are idempotent", () => {
    const endpoints = parseGraphQLIntrospection(MINIMAL_INTROSPECTION_JSON);
    for (const ep of endpoints.filter((e) => e.path.includes("Query."))) {
      expect(ep.idempotent).toBe(true);
    }
  });

  test("Mutation endpoints are not idempotent", () => {
    const endpoints = parseGraphQLIntrospection(MINIMAL_INTROSPECTION_JSON);
    for (const ep of endpoints.filter((e) => e.path.includes("Mutation."))) {
      expect(ep.idempotent).toBe(false);
    }
  });

  test("hero query endpoint is present", () => {
    const endpoints = parseGraphQLIntrospection(MINIMAL_INTROSPECTION_JSON);
    const hero = endpoints.find((e) => e.path === "/graphql#Query.hero");
    expect(hero).toBeDefined();
  });

  test("createHero mutation endpoint is present", () => {
    const endpoints = parseGraphQLIntrospection(MINIMAL_INTROSPECTION_JSON);
    const createHero = endpoints.find((e) => e.path === "/graphql#Mutation.createHero");
    expect(createHero).toBeDefined();
  });

  test("throws on invalid JSON", () => {
    expect(() => parseGraphQLIntrospection("not-json")).toThrow();
  });

  test("throws when data field is missing", () => {
    expect(() =>
      parseGraphQLIntrospection(JSON.stringify({ errors: [{ message: "bad" }] })),
    ).toThrow();
  });

  test("expected_statuses contains 200", () => {
    const endpoints = parseGraphQLIntrospection(MINIMAL_INTROSPECTION_JSON);
    for (const ep of endpoints) {
      expect(ep.expected_statuses).toContain(200);
    }
  });
});
