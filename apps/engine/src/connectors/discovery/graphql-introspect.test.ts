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

type SchemaWithDefs = { $defs?: Record<string, unknown> };

function unresolvedRefs(schema: SchemaWithDefs): string[] {
  const refs = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (key === "$ref" && typeof item === "string") refs.add(item);
        else visit(item);
      }
    }
  };
  visit(schema);
  return [...refs].filter((ref) => !(ref.replace("#/$defs/", "") in (schema.$defs ?? {})));
}

const scalar = (name: string) => ({ kind: "SCALAR", name, ofType: null });
const nonNull = (ofType: unknown) => ({ kind: "NON_NULL", name: null, ofType });
const listOf = (ofType: unknown) => ({ kind: "LIST", name: null, ofType });
const namedRef = (kind: string, name: string) => ({ kind, name, ofType: null });

function largeMutationSchema(mutationCount: number) {
  const indexes = Array.from({ length: mutationCount }, (_, index) => index);
  const levels = Array.from({ length: 8 }, (_, level) => level);
  const recordNames = Array.from({ length: 30 }, (_, index) => `Record${index}`);
  const levelInputs = levels.map((level) => ({
    kind: "INPUT_OBJECT",
    name: `Level${level}Input`,
    inputFields: [
      { name: "label", type: nonNull(scalar("String")) },
      { name: "weight", type: scalar("Int") },
      ...(level < levels.length - 1
        ? [
            { name: "child", type: namedRef("INPUT_OBJECT", `Level${level + 1}Input`) },
            { name: "children", type: listOf(namedRef("INPUT_OBJECT", `Level${level + 1}Input`)) },
          ]
        : []),
    ],
  }));
  const sharedInput = {
    kind: "INPUT_OBJECT",
    name: "SharedInput",
    inputFields: [
      { name: "root", type: nonNull(namedRef("INPUT_OBJECT", "Level0Input")) },
      { name: "tags", type: listOf(nonNull(scalar("String"))) },
    ],
  };
  const records = recordNames.map((name) => ({
    kind: "OBJECT",
    name,
    interfaces: [],
    fields: [
      { name: "id", args: [], type: nonNull(scalar("ID")), isDeprecated: false },
      ...recordNames.map((target) => ({
        name: `to${target}`,
        args: [],
        type: listOf(namedRef("OBJECT", target)),
        isDeprecated: false,
      })),
    ],
  }));
  const inputs = indexes.map((index) => ({
    kind: "INPUT_OBJECT",
    name: `Mutation${index}Input`,
    inputFields: [
      { name: "clientMutationId", type: scalar("String") },
      { name: "shared", type: nonNull(namedRef("INPUT_OBJECT", "SharedInput")) },
    ],
  }));
  const payloads = indexes.map((index) => ({
    kind: "OBJECT",
    name: `Mutation${index}Payload`,
    interfaces: [],
    fields: [
      {
        name: "record",
        args: [],
        type: namedRef("OBJECT", recordNames[index % recordNames.length] ?? "Record0"),
        isDeprecated: false,
      },
    ],
  }));
  const mutationType = {
    kind: "OBJECT",
    name: "Mutation",
    interfaces: [],
    fields: indexes.map((index) => ({
      name: `mutation${index}`,
      args: [{ name: "input", type: nonNull(namedRef("INPUT_OBJECT", `Mutation${index}Input`)) }],
      type: namedRef("OBJECT", `Mutation${index}Payload`),
      isDeprecated: false,
    })),
  };
  const queryType = {
    kind: "OBJECT",
    name: "Query",
    interfaces: [],
    fields: [
      { name: "record", args: [], type: namedRef("OBJECT", "Record0"), isDeprecated: false },
    ],
  };
  return {
    data: {
      __schema: {
        queryType: { name: "Query" },
        mutationType: { name: "Mutation" },
        subscriptionType: null,
        types: [
          queryType,
          mutationType,
          sharedInput,
          ...levelInputs,
          ...records,
          ...inputs,
          ...payloads,
          { kind: "SCALAR", name: "String" },
          { kind: "SCALAR", name: "ID" },
          { kind: "SCALAR", name: "Int" },
        ],
      },
    },
  };
}

function wideQuerySchema(fieldCount: number) {
  return {
    data: {
      __schema: {
        queryType: { name: "Query" },
        mutationType: null,
        subscriptionType: null,
        types: [
          {
            kind: "OBJECT",
            name: "Query",
            interfaces: [],
            fields: Array.from({ length: fieldCount }, (_, index) => ({
              name: `field${index}`,
              args: [],
              type: scalar("String"),
              isDeprecated: false,
            })),
          },
          { kind: "SCALAR", name: "String" },
        ],
      },
    },
  };
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

  seamTest("resolves every reference of a small schema through local definitions", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(SAMPLE_SCHEMA), { status: 200 }));

    const result = await graphqlIntrospectStrategy.fetch("https://api.github.com/graphql", {});

    const viewer = result.endpoints.find((e) => e.operation_id === "viewer");
    const response = viewer?.response_schemas["200"] as SchemaWithDefs;
    expect(response.$defs?.User).toEqual({
      type: "object",
      properties: { login: { type: "String" } },
    });
    expect(unresolvedRefs(response)).toEqual([]);
    const createIssue = result.endpoints.find((e) => e.operation_id === "createIssue");
    const request = createIssue?.request_body_schema as SchemaWithDefs;
    expect(request.$defs?.CreateIssueInput).toMatchObject({ required: ["repositoryId", "title"] });
    expect(unresolvedRefs(request)).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  seamTest("bounds a large mutation schema and shares each definition", async () => {
    const introspection = largeMutationSchema(400);
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(introspection), { status: 200 }));

    const startedAt = performance.now();
    const result = await graphqlIntrospectStrategy.fetch("https://api.github.com/graphql", {});
    const durationMs = performance.now() - startedAt;

    expect(result.endpoints).toHaveLength(401);
    expect(countSchemaNodes(result.endpoints)).toBeLessThan(260_000);
    expect(durationMs).toBeLessThan(5_000);
    expect(result.warnings.map((w) => w.code)).toContain("schema_truncated");
    const definitionInstances = new Map<string, unknown>();
    for (const endpoint of result.endpoints) {
      for (const schema of [endpoint.request_body_schema, endpoint.response_schemas["200"]]) {
        for (const [name, definition] of Object.entries((schema as SchemaWithDefs).$defs ?? {})) {
          const known = definitionInstances.get(name);
          if (known) expect(definition).toBe(known);
          else definitionInstances.set(name, definition);
        }
      }
    }
    expect(definitionInstances.has("SharedInput")).toBe(true);
    const first = result.endpoints.find((e) => e.operation_id === "mutation0");
    const firstRequest = first?.request_body_schema as SchemaWithDefs;
    expect(Object.keys(firstRequest.$defs ?? {})).toContain("Mutation0Input");
    expect(JSON.stringify(firstRequest).split('"Mutation0Input":{').length).toBe(2);
  });

  seamTest("caps the number of endpoints and reports the truncation", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(wideQuerySchema(1_100)), { status: 200 }),
    );

    const result = await graphqlIntrospectStrategy.fetch("https://api.github.com/graphql", {});

    expect(result.endpoints).toHaveLength(1_000);
    expect(result.warnings.map((w) => w.code)).toContain("endpoints_truncated");
  });

  seamTest("skips SDL rendering for an oversized introspection result", async () => {
    const padded = structuredClone(SAMPLE_SCHEMA);
    const types = padded.data.__schema.types as { description?: string }[];
    const firstType = types[0];
    if (firstType) firstType.description = "x".repeat(5 * 1024 * 1024);
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(padded), { status: 200 }));

    const result = await graphqlIntrospectStrategy.fetch("https://api.github.com/graphql", {});

    expect(result.endpoints).toHaveLength(3);
    expect(result.text_corpus).toBeNull();
    expect(result.warnings.map((w) => w.code)).toContain("sdl_skipped");
  });

  seamTest("stops discovery before any request when the signal is already aborted", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(SAMPLE_SCHEMA), { status: 200 }));
    const controller = new AbortController();
    controller.abort();

    const caught = await caughtDiscoveryError(() =>
      graphqlIntrospectStrategy.fetch("https://api.github.com/graphql", {
        signal: controller.signal,
      }),
    );

    expect(caught?.code).toBe("aborted");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  seamTest("stops expansion when the signal aborts during discovery", async () => {
    const controller = new AbortController();
    fetchSpy.mockImplementation((async () => {
      setImmediate(() => controller.abort());
      return new Response(JSON.stringify(largeMutationSchema(400)), { status: 200 });
    }) as unknown as typeof fetch);

    const caught = await caughtDiscoveryError(() =>
      graphqlIntrospectStrategy.fetch("https://api.github.com/graphql", {
        signal: controller.signal,
      }),
    );

    expect(caught).toBeInstanceOf(DiscoveryError);
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
