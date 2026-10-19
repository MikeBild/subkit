import { beforeEach, describe, expect, mock, test } from "bun:test";
import { withSelfHostedDriverFetchForTests } from "../../test-helpers/driver-fetch.ts";
import { importConnectorFromSpecTool } from "../tools/import-connector-from-spec.ts";

// biome-ignore lint/suspicious/noExplicitAny: minimal stub for stateless tool
const nullCtx = null as any;
let fetchSpy: ReturnType<typeof mock<typeof fetch>>;

beforeEach(() => {
  fetchSpy = mock<typeof fetch>();
});

describe("importConnectorFromSpecTool", () => {
  test("tool name is import_connector_from_spec", () => {
    expect(importConnectorFromSpecTool.name).toBe("import_connector_from_spec");
  });

  test("curl command with GitHub URL → template_match for github", async () => {
    const result = await importConnectorFromSpecTool.execute(nullCtx, {
      source: "curl",
      content:
        "curl -H 'Authorization: Bearer ghp_xxx' https://api.github.com/repos/owner/repo/issues",
      environment: "dev",
    });
    expect(result.ok).toBe(true);
    const data = result.data as {
      template_match: { slug: string } | null;
      draft: { driver: string };
    };
    expect(data.template_match).not.toBeNull();
    expect(data.template_match!.slug).toMatch(/github/);
    expect(data.draft.driver).toBe("http");
  });

  test("curl command with unknown domain → manual fallback (template_match=null)", async () => {
    const result = await importConnectorFromSpecTool.execute(nullCtx, {
      source: "curl",
      content:
        "curl -H 'Authorization: Bearer token' https://unknown-domain-xyz-12345.example.com/api/v1/resource",
      environment: "dev",
    });
    expect(result.ok).toBe(true);
    const data = result.data as { template_match: null; draft: { driver: string } };
    expect(data.template_match).toBeNull();
    expect(data.draft.driver).toBe("http");
  });

  test("curl with bearer auth → draft auth_type bearer", async () => {
    const result = await importConnectorFromSpecTool.execute(nullCtx, {
      source: "curl",
      content:
        "curl -H 'Authorization: Bearer token' https://unknown-domain-xyz-12345.example.com/api",
      environment: "dev",
    });
    const data = result.data as { draft: { auth_type: string } };
    expect(data.draft.auth_type).toBe("bearer");
  });

  test("result includes recommended_next array", async () => {
    const result = await importConnectorFromSpecTool.execute(nullCtx, {
      source: "curl",
      content: "curl https://api.stripe.com/v1/charges",
      environment: "dev",
    });
    const data = result.data as { recommended_next: string[] };
    expect(Array.isArray(data.recommended_next)).toBe(true);
    expect(data.recommended_next.length).toBeGreaterThan(0);
  });

  test("curl with explicit -X POST method is captured", async () => {
    const result = await importConnectorFromSpecTool.execute(nullCtx, {
      source: "curl",
      content: 'curl -X POST -d \'{"name":"Alice"}\' https://api.stripe.com/v1/customers',
      environment: "dev",
    });
    expect(result.ok).toBe(true);
  });

  test("invalid source throws via schema validation", async () => {
    await expect(
      importConnectorFromSpecTool.execute(nullCtx, {
        source: "xml",
        content: "<root/>",
        environment: "dev",
      }),
    ).rejects.toThrow();
  });

  test("Cloudflare OpenAPI metadata seeds the API server and bearer auth", async () => {
    const cloudflareSpec = JSON.stringify({
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
    });
    fetchSpy.mockResolvedValue(
      new Response(cloudflareSpec, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await withSelfHostedDriverFetchForTests(
      fetchSpy as unknown as typeof fetch,
      () =>
        importConnectorFromSpecTool.execute(nullCtx, {
          source: "openapi",
          content: "https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json",
          environment: "dev",
        }),
    );
    const data = result.data as {
      template_match: { slug: string };
      draft: {
        auth_type: string;
        base_url: string;
        config: { imported_sample_endpoints: Array<{ path: string }> };
      };
    };
    expect(data.template_match.slug).toBe("cloudflare");
    expect(data.draft.base_url).toBe("https://api.cloudflare.com/client/v4");
    expect(data.draft.auth_type).toBe("bearer");
    expect(data.draft.config.imported_sample_endpoints[0]?.path).toBe("/user/tokens/verify");
  });

  test("Firebase Discovery metadata matches the built-in Firebase template", async () => {
    const discovery = JSON.stringify({
      kind: "discovery#restDescription",
      protocol: "rest",
      title: "Cloud Firestore API",
      version: "v1",
      rootUrl: "https://firestore.googleapis.com/",
      servicePath: "",
      auth: {
        oauth2: {
          scopes: {
            "https://www.googleapis.com/auth/datastore": { description: "Firestore access" },
          },
        },
      },
      schemas: { Document: { type: "object" } },
      resources: {
        projects: {
          resources: {
            databases: {
              resources: {
                documents: {
                  methods: {
                    get: {
                      id: "firestore.projects.databases.documents.get",
                      httpMethod: "GET",
                      flatPath:
                        "v1/projects/{projectsId}/databases/{databasesId}/documents/{documentsId}",
                      response: { $ref: "Document" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    const result = await importConnectorFromSpecTool.execute(nullCtx, {
      source: "google_discovery",
      content: discovery,
      environment: "prod",
    });
    const data = result.data as {
      template_match: { slug: string };
      draft: {
        auth_type: string;
        base_url: string;
        config: {
          imported_source: string;
          imported_sample_endpoints: Array<{ method: string; path: string }>;
        };
      };
    };
    expect(data.template_match.slug).toBe("firebase");
    expect(data.draft.base_url).toBe("https://firestore.googleapis.com");
    expect(data.draft.auth_type).toBe("oauth2");
    expect(data.draft.config.imported_source).toBe("google_discovery");
    expect(data.draft.config.imported_sample_endpoints[0]).toMatchObject({
      method: "GET",
      path: "/v1/projects/{projectsId}/databases/{databasesId}/documents/{documentsId}",
    });
  });
});
