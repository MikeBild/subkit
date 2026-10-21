import { beforeEach, describe, expect, mock, test } from "bun:test";
import { withSelfHostedDriverFetchForTests } from "../../test-helpers/driver-fetch.ts";
import { graphqlIntrospectStrategy, looksLikeGraphQLUrl } from "./graphql-introspect.ts";
import { DiscoveryError } from "./types.ts";

let fetchSpy: ReturnType<typeof mock<typeof fetch>>;

beforeEach(() => {
  fetchSpy = mock<typeof fetch>();
});

function seamTest(name: string, body: () => Promise<void>) {
  test(name, () => withSelfHostedDriverFetchForTests(fetchSpy as unknown as typeof fetch, body));
}

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

  seamTest("maps 401 to auth_required (needs credentials, not generic failure)", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 401 }));

    let caught: DiscoveryError | null = null;
    try {
      await graphqlIntrospectStrategy.fetch("https://api.example.com/graphql", {});
    } catch (e) {
      if (e instanceof DiscoveryError) caught = e;
    }
    expect(caught?.code).toBe("auth_required");
  });

  seamTest("maps 403 to auth_required", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 403 }));

    let caught: DiscoveryError | null = null;
    try {
      await graphqlIntrospectStrategy.fetch("https://api.example.com/graphql", {});
    } catch (e) {
      if (e instanceof DiscoveryError) caught = e;
    }
    expect(caught?.code).toBe("auth_required");
  });

  seamTest("emits SDL text_corpus alongside normalised endpoints", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(SAMPLE_SCHEMA), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await graphqlIntrospectStrategy.fetch("https://api.github.com/graphql", {});

    expect(typeof result.text_corpus).toBe("string");
    const sdl = result.text_corpus ?? "";
    expect(sdl).toContain("type Query");
    expect(sdl).toContain("type Mutation");
    expect(sdl).toContain("repository(owner: String!, name: String!): Repository");
    expect(sdl).toContain("input CreateIssueInput");
    expect(sdl).toContain("repositoryId: ID!");
    expect(result.endpoints).toHaveLength(3);
  });
});

const objectRef = (name: string) => ({
  kind: "NON_NULL",
  name: null,
  ofType: {
    kind: "LIST",
    name: null,
    ofType: { kind: "OBJECT", name, ofType: null },
  },
});

function denselyConnectedSchema(typeCount: number) {
  const names = Array.from({ length: typeCount }, (_, index) => `Node${index}`);
  const nodeTypes = names.map((name) => ({
    kind: "OBJECT",
    name,
    interfaces: [],
    fields: [
      {
        name: "id",
        args: [],
        type: { kind: "SCALAR", name: "ID", ofType: null },
        isDeprecated: false,
      },
      ...names.map((target) => ({
        name: `to${target}`,
        args: [],
        type: objectRef(target),
        isDeprecated: false,
      })),
    ],
  }));
  const queryType = {
    kind: "OBJECT",
    name: "Query",
    interfaces: [],
    fields: names.slice(0, 3).map((target) => ({
      name: `root${target}`,
      args: [],
      type: { kind: "OBJECT", name: target, ofType: null },
      isDeprecated: false,
    })),
  };
  return {
    data: {
      __schema: {
        queryType: { name: "Query" },
        mutationType: null,
        subscriptionType: null,
        types: [queryType, ...nodeTypes],
      },
    },
  };
}

function countSchemaNodes(value: unknown): number {
  if (Array.isArray(value)) return 1 + value.reduce((sum, item) => sum + countSchemaNodes(item), 0);
  if (value !== null && typeof value === "object") {
    return 1 + Object.values(value).reduce<number>((sum, item) => sum + countSchemaNodes(item), 0);
  }
  return 1;
}

function chunkedBody(totalChunks: number, chunkBytes: number) {
  const state = { pulled: 0, cancelled: false };
  const chunk = new Uint8Array(chunkBytes).fill(32);
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        state.pulled += 1;
        controller.enqueue(chunk);
        if (state.pulled >= totalChunks) controller.close();
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { state, body };
}

async function caughtDiscoveryError(run: () => Promise<unknown>): Promise<DiscoveryError | null> {
  try {
    await run();
    return null;
  } catch (e) {
    return e instanceof DiscoveryError ? e : null;
  }
}

describe("graphqlIntrospectStrategy resource bounds", () => {
  seamTest("bounds response schema expansion on a densely connected schema", async () => {
    fetchSpy.mockImplementation(
      (async () =>
        new Response(JSON.stringify(denselyConnectedSchema(8)), {
          status: 200,
        })) as unknown as typeof fetch,
    );

    const result = await graphqlIntrospectStrategy.fetch("https://api.github.com/graphql", {});

    expect(result.endpoints).toHaveLength(3);
    for (const endpoint of result.endpoints) {
      const nodes = countSchemaNodes(endpoint.response_schemas["200"]);
      expect(nodes).toBeLessThan(8_000);
      expect(JSON.stringify(endpoint.response_schemas["200"])).toContain('"$ref"');
    }
    const first = JSON.stringify(result.endpoints);
    const again = await graphqlIntrospectStrategy.fetch("https://api.github.com/graphql", {});
    expect(JSON.stringify(again.endpoints)).toBe(first);
  });

  seamTest("keeps the first levels of a small schema fully expanded", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(SAMPLE_SCHEMA), { status: 200 }));

    const result = await graphqlIntrospectStrategy.fetch("https://api.github.com/graphql", {});

    const viewer = result.endpoints.find((e) => e.operation_id === "viewer");
    expect(JSON.stringify(viewer?.response_schemas["200"])).not.toContain('"$ref"');
  });

  seamTest(
    "stops reading an oversized introspection body as soon as the cap is exceeded",
    async () => {
      const { state, body } = chunkedBody(64, 1024 * 1024);
      fetchSpy.mockResolvedValue(new Response(body, { status: 200 }));

      const caught = await caughtDiscoveryError(() =>
        graphqlIntrospectStrategy.fetch("https://api.github.com/graphql", {}),
      );

      expect(caught?.code).toBe("spec_too_large");
      expect(state.pulled).toBeLessThanOrEqual(18);
      expect(state.cancelled).toBe(true);
    },
  );

  seamTest("rejects a declared oversized body without reading it", async () => {
    const { state, body } = chunkedBody(4, 1024);
    fetchSpy.mockResolvedValue(
      new Response(body, { status: 200, headers: { "content-length": String(32 * 1024 * 1024) } }),
    );

    const caught = await caughtDiscoveryError(() =>
      graphqlIntrospectStrategy.fetch("https://api.github.com/graphql", {}),
    );

    expect(caught?.code).toBe("spec_too_large");
    expect(state.pulled).toBe(0);
  });
});
