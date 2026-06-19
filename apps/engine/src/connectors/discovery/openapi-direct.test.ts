import { beforeEach, describe, expect, mock, test } from "bun:test";
import { withDriverFetchForTests } from "../../test-helpers/driver-fetch.ts";
import { normalizeKnownHosts, openApiDirectStrategy } from "./openapi-direct.ts";
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

const STRIPE_LIKE_OPENAPI_3 = {
  openapi: "3.0.3",
  info: { title: "Stripe-shaped API", version: "1.0" },
  servers: [{ url: "https://api.stripe.example.com/v1" }],
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer" },
      oauthFlow: {
        type: "oauth2",
        flows: {
          authorizationCode: {
            authorizationUrl: "https://login.example.com/authorize",
            tokenUrl: "https://login.example.com/token",
            scopes: { "read:customers": "Read customers", "write:customers": "Write customers" },
          },
        },
      },
    },
  },
  paths: {
    "/customers": {
      get: {
        operationId: "listCustomers",
        summary: "List customers",
        description: "Cursor-paginated list",
        deprecated: false,
        parameters: [
          { name: "limit", in: "query", required: false, schema: { type: "integer" } },
          { name: "starting_after", in: "query", required: false, schema: { type: "string" } },
        ],
        security: [{ oauthFlow: ["read:customers"] }],
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: { type: "array", items: { type: "object" } },
                    has_more: { type: "boolean" },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        operationId: "createCustomer",
        summary: "Create a customer",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", properties: { email: { type: "string" } } },
            },
          },
        },
        responses: {
          "200": {
            description: "ok",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
    "/customers/{id}": {
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      get: {
        operationId: "retrieveCustomer",
        responses: { "200": { description: "ok" } },
      },
    },
  },
};

const SWAGGER_2_FIXTURE = {
  swagger: "2.0",
  info: { title: "Legacy API", version: "1.0" },
  host: "legacy.example.com",
  basePath: "/v1",
  schemes: ["https"],
  securityDefinitions: {
    apiKey: { type: "apiKey", in: "header", name: "X-API-Key" },
    basic: { type: "basic" },
  },
  paths: {
    "/things": {
      get: {
        operationId: "listThings",
        parameters: [
          { name: "page", in: "query", type: "integer", required: false },
          { name: "per_page", in: "query", type: "integer", required: false },
        ],
        responses: {
          "200": {
            description: "ok",
            schema: { type: "object", properties: { items: { type: "array" } } },
          },
        },
      },
    },
  },
};

describe("openApiDirectStrategy — OpenAPI 3", () => {
  seamTest("parses endpoints, auth schemes, scopes, pagination", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(STRIPE_LIKE_OPENAPI_3), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await openApiDirectStrategy.fetch("https://api.example.com/openapi.json", {});

    expect(result.strategy).toBe("openapi-direct");
    expect(result.spec_version).toBe("openapi-3");
    expect(result.title).toBe("Stripe-shaped API");
    expect(result.servers).toEqual(["https://api.stripe.example.com/v1"]);
    expect(result.endpoints.length).toBe(3);

    const listCustomers = result.endpoints.find((e) => e.operation_id === "listCustomers");
    expect(listCustomers).toBeDefined();
    expect(listCustomers?.method).toBe("GET");
    expect(listCustomers?.path).toBe("/customers");
    expect(listCustomers?.scopes).toEqual(["read:customers"]);
    expect(listCustomers?.pagination_hint?.kind).toBe("cursor");
    expect(listCustomers?.pagination_hint?.param_names).toContain("starting_after");

    const createCustomer = result.endpoints.find((e) => e.operation_id === "createCustomer");
    expect(createCustomer?.request_body_schema).toBeDefined();

    // Path-level parameter is inherited by operations in the path.
    const retrieveCustomer = result.endpoints.find((e) => e.operation_id === "retrieveCustomer");
    expect(retrieveCustomer?.params.some((p) => p.name === "id" && p.in === "path")).toBe(true);

    // Auth schemes
    const bearer = result.auth_schemes.find((s) => s.name === "bearerAuth");
    expect(bearer?.type).toBe("http");
    expect(bearer?.scheme).toBe("bearer");
    const oauth = result.auth_schemes.find((s) => s.name === "oauthFlow");
    expect(oauth?.type).toBe("oauth2");
    expect(oauth?.flows?.authorizationCode?.token_url).toBe("https://login.example.com/token");
  });

  seamTest("detects link_header pagination on a GET response", async () => {
    const SPEC = {
      openapi: "3.0.0",
      info: { title: "x", version: "1" },
      paths: {
        "/items": {
          get: {
            operationId: "listItems",
            responses: {
              "200": {
                description: "ok",
                content: { "application/json": { schema: { type: "object" } } },
              },
            },
          },
        },
      },
    };
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(SPEC), {
        status: 200,
        headers: {
          "content-type": "application/json",
          link: '<https://api.example.com/items?page=2>; rel="next"',
        },
      }),
    );
    const result = await openApiDirectStrategy.fetch("https://api.example.com/openapi.json", {});
    expect(result.endpoints[0]?.pagination_hint?.kind).toBe("link_header");
  });

  seamTest("DigitalOcean-style links.pages response triggers cursor hint", async () => {
    const SPEC = {
      openapi: "3.0.0",
      info: { title: "x", version: "1" },
      paths: {
        "/account": {
          get: {
            operationId: "getAccount",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        account: { type: "object" },
                        links: {
                          type: "object",
                          properties: {
                            pages: { type: "object" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(SPEC), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await openApiDirectStrategy.fetch("https://api.example.com/openapi.json", {});
    expect(result.endpoints[0]?.pagination_hint?.kind).toBe("cursor");
  });

  seamTest("throws DiscoveryError on non-2xx", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 404 }));
    await expect(
      openApiDirectStrategy.fetch("https://api.example.com/openapi.json", {}),
    ).rejects.toBeInstanceOf(DiscoveryError);
  });

  seamTest("throws unknown_spec_version when spec lacks openapi/swagger fields", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ info: { title: "x" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    let caught: DiscoveryError | null = null;
    try {
      await openApiDirectStrategy.fetch("https://api.example.com/openapi.json", {});
    } catch (e) {
      if (e instanceof DiscoveryError) caught = e;
    }
    expect(caught?.code).toBe("unknown_spec_version");
  });

  seamTest("parses YAML by extension", async () => {
    const yaml = `openapi: 3.0.0
info:
  title: yaml-spec
  version: '1.0'
paths:
  /ping:
    get:
      operationId: ping
      responses:
        '200':
          description: ok
`;
    fetchSpy.mockResolvedValue(
      new Response(yaml, {
        status: 200,
        headers: { "content-type": "text/yaml" },
      }),
    );
    const result = await openApiDirectStrategy.fetch("https://api.example.com/openapi.yaml", {});
    expect(result.title).toBe("yaml-spec");
    expect(result.endpoints[0]?.operation_id).toBe("ping");
  });
});

describe("normalizeKnownHosts", () => {
  test("rewrites SwaggerHub UI host to API host", () => {
    expect(normalizeKnownHosts("https://app.swaggerhub.com/apis/acme/widgets/1.0.0")).toBe(
      "https://api.swaggerhub.com/apis/acme/widgets/1.0.0",
    );
  });

  test("preserves path, query, and fragment when rewriting SwaggerHub", () => {
    expect(normalizeKnownHosts("https://app.swaggerhub.com/apis/acme/widgets/1.0.0?foo=bar")).toBe(
      "https://api.swaggerhub.com/apis/acme/widgets/1.0.0?foo=bar",
    );
  });

  test("is idempotent when called twice", () => {
    const once = normalizeKnownHosts("https://app.swaggerhub.com/apis/acme/widgets/1.0.0");
    expect(normalizeKnownHosts(once)).toBe(once);
  });

  test("rewrites SwaggerHub /apis-docs/ rendered-docs host to API path", () => {
    // Operators frequently paste the docs URL when the spec URL is wanted.
    expect(normalizeKnownHosts("https://app.swaggerhub.com/apis-docs/acme/widgets/1.0.0")).toBe(
      "https://api.swaggerhub.com/apis/acme/widgets/1.0.0",
    );
  });

  test("leaves api.swaggerhub.com unchanged", () => {
    const url = "https://api.swaggerhub.com/apis/acme/widgets/1.0.0";
    expect(normalizeKnownHosts(url)).toBe(url);
  });

  test("leaves unrelated hosts unchanged", () => {
    const url = "https://api.example.com/openapi.json";
    expect(normalizeKnownHosts(url)).toBe(url);
  });

  test("returns input unchanged when not a parseable URL", () => {
    expect(normalizeKnownHosts("not-a-url")).toBe("not-a-url");
  });

  test("does not rewrite SwaggerHub paths outside /apis/", () => {
    const url = "https://app.swaggerhub.com/login";
    expect(normalizeKnownHosts(url)).toBe(url);
  });
});

describe("openApiDirectStrategy — host normalization", () => {
  seamTest("fetches the rewritten URL when given a SwaggerHub UI host", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(STRIPE_LIKE_OPENAPI_3), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await openApiDirectStrategy.fetch("https://app.swaggerhub.com/apis/acme/widgets/1.0.0", {});
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const calledUrl = fetchSpy.mock.calls[0]?.[0];
    expect(calledUrl).toBe("https://api.swaggerhub.com/apis/acme/widgets/1.0.0");
  });
});

describe("openApiDirectStrategy — Swagger 2", () => {
  seamTest("parses Swagger 2 spec into the same shape", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(SWAGGER_2_FIXTURE), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await openApiDirectStrategy.fetch("https://api.example.com/swagger.json", {});
    expect(result.spec_version).toBe("swagger-2");
    expect(result.servers).toEqual(["https://legacy.example.com/v1"]);
    expect(result.endpoints).toHaveLength(1);
    const listThings = result.endpoints[0];
    expect(listThings?.path).toBe("/things");
    expect(listThings?.method).toBe("GET");
    expect(listThings?.pagination_hint?.kind).toBe("page");
    const apiKey = result.auth_schemes.find((s) => s.name === "apiKey");
    expect(apiKey?.type).toBe("apiKey");
    expect(apiKey?.location).toBe("header");
    const basic = result.auth_schemes.find((s) => s.name === "basic");
    expect(basic?.scheme).toBe("basic");
  });
});
