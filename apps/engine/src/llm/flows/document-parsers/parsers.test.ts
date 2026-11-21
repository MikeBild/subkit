import { describe, expect, it } from "bun:test";
import { parseGraphQL } from "./graphql.ts";
import { parseHar } from "./har.ts";
import { parseOpenApi, parseOpenApiWithMetadata } from "./openapi.ts";
import { parsePostman } from "./postman.ts";

const MINIMAL_OPENAPI = JSON.stringify({
  openapi: "3.0.0",
  paths: {
    "/users": {
      get: { summary: "List users", responses: { "200": {}, "404": {} } },
      post: { summary: "Create user", responses: { "201": {}, "400": {} } },
    },
  },
});

describe("parseOpenApi", () => {
  it("returns two endpoints for a path with GET and POST", () => {
    const endpoints = parseOpenApi(MINIMAL_OPENAPI);
    expect(endpoints).toHaveLength(2);
  });

  it("parses GET endpoint with correct path and method", () => {
    const endpoints = parseOpenApi(MINIMAL_OPENAPI);
    const get = endpoints.find((e) => e.method === "GET");
    expect(get).toBeDefined();
    expect(get!.path).toBe("/users");
  });

  it("parses POST endpoint with correct path and method", () => {
    const endpoints = parseOpenApi(MINIMAL_OPENAPI);
    const post = endpoints.find((e) => e.method === "POST");
    expect(post).toBeDefined();
    expect(post!.path).toBe("/users");
  });

  it("GET endpoint includes expected_statuses [200, 404]", () => {
    const endpoints = parseOpenApi(MINIMAL_OPENAPI);
    const get = endpoints.find((e) => e.method === "GET")!;
    expect(get.expected_statuses).toContain(200);
    expect(get.expected_statuses).toContain(404);
  });

  it("POST endpoint includes expected_statuses [201, 400]", () => {
    const endpoints = parseOpenApi(MINIMAL_OPENAPI);
    const post = endpoints.find((e) => e.method === "POST")!;
    expect(post.expected_statuses).toContain(201);
    expect(post.expected_statuses).toContain(400);
  });

  it("GET is idempotent", () => {
    const endpoints = parseOpenApi(MINIMAL_OPENAPI);
    const get = endpoints.find((e) => e.method === "GET")!;
    expect(get.idempotent).toBe(true);
  });

  it("POST is not idempotent", () => {
    const endpoints = parseOpenApi(MINIMAL_OPENAPI);
    const post = endpoints.find((e) => e.method === "POST")!;
    expect(post.idempotent).toBe(false);
  });

  it("carries the operation summary as description", () => {
    const endpoints = parseOpenApi(MINIMAL_OPENAPI);
    const get = endpoints.find((e) => e.method === "GET")!;
    expect(get.description).toBe("List users");
    const post = endpoints.find((e) => e.method === "POST")!;
    expect(post.description).toBe("Create user");
  });

  it("throws on invalid JSON input", () => {
    expect(() => parseOpenApi("not json at all")).toThrow();
  });

  it("returns empty array when paths is absent", () => {
    const doc = JSON.stringify({ openapi: "3.0.0" });
    expect(parseOpenApi(doc)).toHaveLength(0);
  });

  it("PUT and DELETE are treated as idempotent", () => {
    const doc = JSON.stringify({
      openapi: "3.0.0",
      paths: {
        "/items/{id}": {
          put: { responses: { "200": {} } },
          delete: { responses: { "204": {} } },
        },
      },
    });
    const endpoints = parseOpenApi(doc);
    const put = endpoints.find((e) => e.method === "PUT")!;
    const del = endpoints.find((e) => e.method === "DELETE")!;
    expect(put.idempotent).toBe(true);
    expect(del.idempotent).toBe(true);
  });

  it("PATCH is not idempotent", () => {
    const doc = JSON.stringify({
      openapi: "3.0.0",
      paths: { "/items/{id}": { patch: { responses: { "200": {} } } } },
    });
    const endpoints = parseOpenApi(doc);
    expect(endpoints[0]!.idempotent).toBe(false);
  });

  it("defaults expected_statuses to [200] when no valid numeric status codes are present", () => {
    const doc = JSON.stringify({
      openapi: "3.0.0",
      paths: {
        "/noop": { get: { responses: { default: {} } } },
      },
    });
    const [endpoint] = parseOpenApi(doc);
    expect(endpoint!.expected_statuses).toEqual([200]);
  });

  it("parses YAML documents", () => {
    const yaml = `
openapi: 3.0.3
paths:
  /status:
    get:
      summary: Get status
      responses:
        "200": {}
`;
    const [endpoint] = parseOpenApi(yaml);
    expect(endpoint?.path).toBe("/status");
    expect(endpoint?.method).toBe("GET");
  });

  it("extracts the API server and prefers bearer among alternative security schemes", () => {
    const parsed = parseOpenApiWithMetadata(
      JSON.stringify({
        openapi: "3.0.3",
        servers: [{ url: "https://api.cloudflare.com/client/v4" }],
        security: [{ api_email: [], api_key: [] }, { api_token: [] }],
        components: {
          securitySchemes: {
            api_email: { in: "header", name: "X-Auth-Email", type: "apiKey" },
            api_key: { in: "header", name: "X-Auth-Key", type: "apiKey" },
            api_token: { scheme: "bearer", type: "http" },
          },
        },
        paths: { "/user/tokens/verify": { get: { responses: { "200": {} } } } },
      }),
    );
    expect(parsed.servers).toEqual(["https://api.cloudflare.com/client/v4"]);
    expect(parsed.auth_hint).toEqual({ type: "bearer" });
  });

  it("resolves relative servers against the spec URL and expands variable defaults", () => {
    const parsed = parseOpenApiWithMetadata(
      JSON.stringify({
        openapi: "3.0.3",
        servers: [
          {
            url: "https://{region}.example.com/{version}",
            variables: {
              region: { default: "eu" },
              version: { default: "v2" },
            },
          },
          { url: "/client/v4" },
        ],
        paths: {},
      }),
      "https://docs.example.com/spec/openapi.json",
    );
    expect(parsed.servers).toEqual([
      "https://eu.example.com/v2",
      "https://docs.example.com/client/v4",
    ]);
  });

  it("ignores unresolved template variables and non-HTTP server protocols", () => {
    const parsed = parseOpenApiWithMetadata(
      JSON.stringify({
        openapi: "3.0.3",
        servers: [{ url: "https://{region}.example.com" }, { url: "file:///tmp/api" }],
        paths: {},
      }),
    );
    expect(parsed.servers).toEqual([]);
  });

  it("detects OAuth2, header, query, and basic authentication", () => {
    const cases = [
      [{ type: "oauth2", flows: {} }, { type: "oauth2" }],
      [
        { type: "apiKey", in: "header", name: "X-API-Key" },
        { type: "header", header_name: "X-API-Key" },
      ],
      [
        { type: "apiKey", in: "query", name: "api_key" },
        { type: "query", query_param: "api_key" },
      ],
      [{ type: "http", scheme: "basic" }, { type: "basic" }],
    ] as const;
    for (const [scheme, expected] of cases) {
      const parsed = parseOpenApiWithMetadata(
        JSON.stringify({
          openapi: "3.0.3",
          security: [{ auth: [] }],
          components: { securitySchemes: { auth: scheme } },
          paths: {},
        }),
      );
      expect(parsed.auth_hint).toEqual(expected);
    }
  });

  it("does not infer authentication from unreferenced schemes when security is anonymous", () => {
    const parsed = parseOpenApiWithMetadata(
      JSON.stringify({
        openapi: "3.0.3",
        security: [],
        components: {
          securitySchemes: { unused: { type: "http", scheme: "bearer" } },
        },
        paths: {},
      }),
    );
    expect(parsed.auth_hint).toBeNull();
  });
});

const MINIMAL_POSTMAN = JSON.stringify({
  item: [
    {
      name: "Get users",
      request: {
        method: "GET",
        url: { path: ["api", "users"] },
      },
    },
  ],
});

describe("parsePostman", () => {
  it("returns one endpoint for a collection with one request", () => {
    const endpoints = parsePostman(MINIMAL_POSTMAN);
    expect(endpoints).toHaveLength(1);
  });

  it("builds path from url.path array", () => {
    const [ep] = parsePostman(MINIMAL_POSTMAN);
    expect(ep!.path).toBe("/api/users");
  });

  it("uppercases the method", () => {
    const [ep] = parsePostman(MINIMAL_POSTMAN);
    expect(ep!.method).toBe("GET");
  });

  it("GET request is idempotent", () => {
    const [ep] = parsePostman(MINIMAL_POSTMAN);
    expect(ep!.idempotent).toBe(true);
  });

  it("uses item name as description", () => {
    const [ep] = parsePostman(MINIMAL_POSTMAN);
    expect(ep!.description).toBe("Get users");
  });

  it("defaults expected_statuses to [200]", () => {
    const [ep] = parsePostman(MINIMAL_POSTMAN);
    expect(ep!.expected_statuses).toEqual([200]);
  });

  it("returns empty array for a collection with no items", () => {
    const doc = JSON.stringify({ item: [] });
    expect(parsePostman(doc)).toHaveLength(0);
  });

  it("flattens nested folder items", () => {
    const doc = JSON.stringify({
      item: [
        {
          name: "Folder",
          item: [
            {
              name: "Nested request",
              request: { method: "POST", url: { path: ["v1", "orders"] } },
            },
          ],
        },
      ],
    });
    const endpoints = parsePostman(doc);
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]!.path).toBe("/v1/orders");
    expect(endpoints[0]!.idempotent).toBe(false);
  });

  it("infers request_schema from a raw JSON body", () => {
    const doc = JSON.stringify({
      item: [
        {
          name: "Create order",
          request: {
            method: "POST",
            url: { path: ["v1", "orders"] },
            body: { mode: "raw", raw: JSON.stringify({ product: "widget", qty: 1 }) },
          },
        },
      ],
    });
    const [ep] = parsePostman(doc);
    expect(ep!.request_schema).toBeDefined();
    expect((ep!.request_schema as { type: string }).type).toBe("object");
  });
});

const MINIMAL_HAR = JSON.stringify({
  log: {
    entries: [
      {
        request: {
          method: "GET",
          url: "https://api.example.com/v1/users",
          headers: [],
          postData: null,
        },
        response: { status: 200 },
      },
      {
        request: {
          method: "GET",
          url: "https://api.example.com/v1/users",
          headers: [],
        },
        response: { status: 404 },
      },
    ],
  },
});

describe("parseHar", () => {
  it("deduplicates entries with the same method + path", () => {
    const endpoints = parseHar(MINIMAL_HAR);
    expect(endpoints).toHaveLength(1);
  });

  it("merges status codes from duplicate entries", () => {
    const [ep] = parseHar(MINIMAL_HAR);
    expect(ep!.expected_statuses).toContain(200);
    expect(ep!.expected_statuses).toContain(404);
  });

  it("extracts the correct path (strips host)", () => {
    const [ep] = parseHar(MINIMAL_HAR);
    expect(ep!.path).toBe("/v1/users");
  });

  it("GET entry is idempotent", () => {
    const [ep] = parseHar(MINIMAL_HAR);
    expect(ep!.idempotent).toBe(true);
  });

  it("POST entry is not idempotent", () => {
    const har = JSON.stringify({
      log: {
        entries: [
          {
            request: { method: "POST", url: "https://api.example.com/v1/users", headers: [] },
            response: { status: 201 },
          },
        ],
      },
    });
    const [ep] = parseHar(har);
    expect(ep!.idempotent).toBe(false);
  });

  it("returns empty array for HAR with no entries", () => {
    const har = JSON.stringify({ log: { entries: [] } });
    expect(parseHar(har)).toHaveLength(0);
  });

  it("skips entries with an unparseable URL", () => {
    const har = JSON.stringify({
      log: {
        entries: [
          {
            request: { method: "GET", url: "not-a-url", headers: [] },
            response: { status: 200 },
          },
        ],
      },
    });
    expect(parseHar(har)).toHaveLength(0);
  });

  it("treats different methods to the same path as separate endpoints", () => {
    const har = JSON.stringify({
      log: {
        entries: [
          {
            request: { method: "GET", url: "https://api.example.com/items", headers: [] },
            response: { status: 200 },
          },
          {
            request: { method: "POST", url: "https://api.example.com/items", headers: [] },
            response: { status: 201 },
          },
        ],
      },
    });
    const endpoints = parseHar(har);
    expect(endpoints).toHaveLength(2);
  });

  it("does not duplicate a status code already present for the endpoint", () => {
    const har = JSON.stringify({
      log: {
        entries: [
          {
            request: { method: "GET", url: "https://api.example.com/v1/users", headers: [] },
            response: { status: 200 },
          },
          {
            request: { method: "GET", url: "https://api.example.com/v1/users", headers: [] },
            response: { status: 200 },
          },
        ],
      },
    });
    const [ep] = parseHar(har);
    const count = ep!.expected_statuses.filter((s) => s === 200).length;
    expect(count).toBe(1);
  });

  it("infers request_schema from a JSON postData body", () => {
    const har = JSON.stringify({
      log: {
        entries: [
          {
            request: {
              method: "POST",
              url: "https://api.example.com/v1/charges",
              headers: [],
              postData: {
                mimeType: "application/json",
                text: JSON.stringify({ amount: 1000, currency: "usd" }),
              },
            },
            response: { status: 200 },
          },
        ],
      },
    });
    const [ep] = parseHar(har);
    const props = (ep!.request_schema as { properties?: Record<string, unknown> }).properties;
    expect(props).toHaveProperty("amount");
    expect(props).toHaveProperty("currency");
  });
});

const SDL = `type Query {
  getUser(id: ID): User
  listUsers: [User]
}
type Mutation {
  createUser(name: String): User
}`;

describe("parseGraphQL", () => {
  it("returns Query + Mutation entries from SDL", () => {
    const endpoints = parseGraphQL(SDL);
    expect(endpoints.length).toBeGreaterThanOrEqual(3);
  });

  it("emits GET method for Query fields", () => {
    const endpoints = parseGraphQL(SDL);
    const queries = endpoints.filter((e) => e.method === "GET");
    expect(queries.length).toBeGreaterThanOrEqual(2);
  });

  it("emits POST method for Mutation fields", () => {
    const endpoints = parseGraphQL(SDL);
    const mutations = endpoints.filter((e) => e.method === "POST");
    expect(mutations.length).toBeGreaterThanOrEqual(1);
  });

  it("Query fields are idempotent", () => {
    const endpoints = parseGraphQL(SDL);
    for (const ep of endpoints.filter((e) => e.method === "GET")) {
      expect(ep.idempotent).toBe(true);
    }
  });

  it("Mutation fields are not idempotent", () => {
    const endpoints = parseGraphQL(SDL);
    for (const ep of endpoints.filter((e) => e.method === "POST")) {
      expect(ep.idempotent).toBe(false);
    }
  });

  it("paths use the /graphql# prefix for SDL fields", () => {
    const endpoints = parseGraphQL(SDL);
    for (const ep of endpoints) {
      expect(ep.path).toMatch(/^\/graphql#/);
    }
  });

  it("parses Query.getUser and Query.listUsers as separate entries", () => {
    const endpoints = parseGraphQL(SDL);
    const paths = endpoints.map((e) => e.path);
    expect(paths).toContain("/graphql#Query.getUser");
    expect(paths).toContain("/graphql#Query.listUsers");
  });

  it("parses Mutation.createUser as a separate entry", () => {
    const endpoints = parseGraphQL(SDL);
    const paths = endpoints.map((e) => e.path);
    expect(paths).toContain("/graphql#Mutation.createUser");
  });

  it("all expected_statuses default to [200]", () => {
    const endpoints = parseGraphQL(SDL);
    for (const ep of endpoints) {
      expect(ep.expected_statuses).toEqual([200]);
    }
  });

  it("returns empty array for content with no Query or Mutation types", () => {
    const sdl = "type User { id: ID name: String }";
    expect(parseGraphQL(sdl)).toHaveLength(0);
  });
});
