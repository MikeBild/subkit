import { beforeEach, describe, expect, mock, test } from "bun:test";
import { withDriverFetchForTests } from "../../test-helpers/driver-fetch.ts";
import { graphqlIntrospectStrategy, looksLikeGraphQLUrl } from "./graphql-introspect.ts";
import { DiscoveryError } from "./types.ts";

let fetchSpy: ReturnType<typeof mock<typeof fetch>>;

beforeEach(() => {
  fetchSpy = mock<typeof fetch>();
});

// Driver-fetch seam: the code under test reads getDriverFetch(), not
// globalThis — run each body under the seam's explicit wrapper (the
// override must scope the body itself; an enterWith-from-beforeEach
// binding did not propagate into test bodies under bun).
function seamTest(name: string, body: () => Promise<void>) {
  test(name, () => withDriverFetchForTests(fetchSpy as unknown as typeof fetch, body));
}

// A small GitHub-shaped introspection result: 2 query fields + 1 mutation.
// `interfaces: []` is required on OBJECT types for `buildClientSchema` to
// accept the introspection in the SDL-render path.
const SAMPLE_SCHEMA = {
  data: {
    __schema: {
      queryType: { name: "Query" },
      mutationType: { name: "Mutation" },
      subscriptionType: null,
      types: [
        {
          kind: "OBJECT",
          name: "Query",
          interfaces: [],
          fields: [
            {
              name: "viewer",
              description: "The currently authenticated user.",
              args: [],
              type: { kind: "OBJECT", name: "User", ofType: null },
              isDeprecated: false,
            },
            {
              name: "repository",
              description: "Look up a repository by owner and name.",
              args: [
                {
                  name: "owner",
                  type: {
                    kind: "NON_NULL",
                    name: null,
                    ofType: { kind: "SCALAR", name: "String", ofType: null },
                  },
                },
                {
                  name: "name",
                  type: {
                    kind: "NON_NULL",
                    name: null,
                    ofType: { kind: "SCALAR", name: "String", ofType: null },
                  },
                },
              ],
              type: { kind: "OBJECT", name: "Repository", ofType: null },
              isDeprecated: false,
            },
          ],
        },
        {
          kind: "OBJECT",
          name: "Mutation",
          interfaces: [],
          fields: [
            {
              name: "createIssue",
              description: "Open a new issue against a repository.",
              args: [
                {
                  name: "input",
                  type: {
                    kind: "NON_NULL",
                    name: null,
                    ofType: { kind: "INPUT_OBJECT", name: "CreateIssueInput", ofType: null },
                  },
                },
              ],
              type: { kind: "OBJECT", name: "CreateIssuePayload", ofType: null },
              isDeprecated: false,
            },
          ],
        },
        {
          kind: "OBJECT",
          name: "User",
          interfaces: [],
          fields: [
            {
              name: "login",
              args: [],
              type: {
                kind: "NON_NULL",
                name: null,
                ofType: { kind: "SCALAR", name: "String", ofType: null },
              },
              isDeprecated: false,
            },
          ],
        },
        {
          kind: "OBJECT",
          name: "Repository",
          interfaces: [],
          fields: [
            {
              name: "name",
              args: [],
              type: {
                kind: "NON_NULL",
                name: null,
                ofType: { kind: "SCALAR", name: "String", ofType: null },
              },
              isDeprecated: false,
            },
          ],
        },
        {
          kind: "OBJECT",
          name: "CreateIssuePayload",
          interfaces: [],
          fields: [
            {
              name: "issueId",
              args: [],
              type: { kind: "SCALAR", name: "ID", ofType: null },
              isDeprecated: false,
            },
          ],
        },
        {
          kind: "INPUT_OBJECT",
          name: "CreateIssueInput",
          inputFields: [
            {
              name: "repositoryId",
              type: {
                kind: "NON_NULL",
                name: null,
                ofType: { kind: "SCALAR", name: "ID", ofType: null },
              },
            },
            {
              name: "title",
              type: {
                kind: "NON_NULL",
                name: null,
                ofType: { kind: "SCALAR", name: "String", ofType: null },
              },
            },
          ],
        },
        { kind: "SCALAR", name: "String" },
        { kind: "SCALAR", name: "ID" },
      ],
      directives: [],
    },
  },
};

describe("looksLikeGraphQLUrl", () => {
  test("matches /graphql endpoints with optional version suffix", () => {
    expect(looksLikeGraphQLUrl("https://api.github.com/graphql")).toBe(true);
    expect(looksLikeGraphQLUrl("https://api.linear.app/graphql")).toBe(true);
    expect(looksLikeGraphQLUrl("https://api.example.com/graphql/v1")).toBe(true);
    expect(looksLikeGraphQLUrl("https://api.example.com/graphql/")).toBe(true);
  });

  test("rejects unrelated URLs", () => {
    expect(looksLikeGraphQLUrl("https://api.example.com/v1/customers")).toBe(false);
    expect(looksLikeGraphQLUrl("https://example.com")).toBe(false);
    expect(looksLikeGraphQLUrl("not-a-url")).toBe(false);
  });
});

describe("graphqlIntrospectStrategy", () => {
  seamTest("derives endpoints from query + mutation root fields", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(SAMPLE_SCHEMA), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await graphqlIntrospectStrategy.fetch("https://api.github.com/graphql", {});

    expect(result.strategy).toBe("graphql-introspect");
    expect(result.spec_version).toBeNull();
    expect(result.title).toBe("Query");
    expect(result.servers).toEqual(["https://api.github.com/graphql"]);
    expect(result.endpoints).toHaveLength(3);

    const viewer = result.endpoints.find((e) => e.operation_id === "viewer");
    expect(viewer).toBeDefined();
    expect(viewer?.method).toBe("POST");
    expect(viewer?.path).toBe("/graphql");
    expect(viewer?.summary).toBe("The currently authenticated user.");
    expect(viewer?.params).toEqual([]);

    const repository = result.endpoints.find((e) => e.operation_id === "repository");
    expect(repository?.params.find((p) => p.name === "owner")?.required).toBe(true);
    expect(repository?.params.find((p) => p.name === "owner")?.in).toBe("body");
    expect(repository?.params.find((p) => p.name === "owner")?.type).toBe("String!");

    const createIssue = result.endpoints.find((e) => e.operation_id === "createIssue");
    expect(createIssue?.method).toBe("POST");
    expect(createIssue?.summary).toBe("Open a new issue against a repository.");
    expect(createIssue?.params.find((p) => p.name === "input")?.required).toBe(true);
    expect(createIssue?.response_schemas["200"]).toBeDefined();
  });

  seamTest("forwards caller-provided auth headers on the introspection POST", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(SAMPLE_SCHEMA), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await graphqlIntrospectStrategy.fetch("https://api.github.com/graphql", {
      headers: { authorization: "bearer test-token" },
    });

    const call = fetchSpy.mock.calls[0];
    expect(call).toBeDefined();
    const init = call?.[1] as RequestInit | undefined;
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.["content-type"]).toBe("application/json");
    expect(headers?.authorization).toBe("bearer test-token");
    expect(typeof init?.body).toBe("string");
    const parsedBody = JSON.parse(String(init?.body));
    expect(typeof parsedBody.query).toBe("string");
    expect(parsedBody.query).toContain("__schema");
  });

  seamTest("throws introspection_disabled when the server rejects introspection", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ errors: [{ message: "GraphQL introspection is not allowed" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    let caught: DiscoveryError | null = null;
    try {
      await graphqlIntrospectStrategy.fetch("https://api.example.com/graphql", {});
    } catch (e) {
      if (e instanceof DiscoveryError) caught = e;
    }
    expect(caught?.code).toBe("introspection_disabled");
  });

  seamTest("throws http_404 on missing endpoint", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 404 }));

    let caught: DiscoveryError | null = null;
    try {
      await graphqlIntrospectStrategy.fetch("https://api.example.com/graphql", {});
    } catch (e) {
      if (e instanceof DiscoveryError) caught = e;
    }
    expect(caught?.code).toBe("http_404");
  });

  seamTest("emits SDL text_corpus alongside normalised endpoints", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(SAMPLE_SCHEMA), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await graphqlIntrospectStrategy.fetch("https://api.github.com/graphql", {});

    // SDL is required for the LLM to author deep-nested queries — the
    // normalised `endpoints` only describe top-level field args, not the
    // selection set. Pre-fix this was thrown away.
    expect(typeof result.text_corpus).toBe("string");
    const sdl = result.text_corpus ?? "";
    expect(sdl).toContain("type Query");
    expect(sdl).toContain("type Mutation");
    expect(sdl).toContain("repository(owner: String!, name: String!): Repository");
    expect(sdl).toContain("input CreateIssueInput");
    expect(sdl).toContain("repositoryId: ID!");
    // Endpoints still come through.
    expect(result.endpoints).toHaveLength(3);
  });
});
