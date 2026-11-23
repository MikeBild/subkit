import { describe, expect, test } from "bun:test";
import { getBuiltinTemplate } from "../templates.ts";
import {
  CONTRACT_SECRETS,
  type ContractIssue,
  checkTemplateContract,
  contractCredential,
  contractKind,
  type ExchangeContract,
  ExchangeContractSchema,
  expectedAuthHeader,
  type SchemaContract,
  scaffoldTemplateContract,
} from "./contract.ts";

function template(slug: string) {
  const found = getBuiltinTemplate(slug);
  if (!found) throw new Error(`template ${slug} missing`);
  return found;
}

function exchange(slug: string): ExchangeContract {
  return ExchangeContractSchema.parse(scaffoldTemplateContract(template(slug)));
}

function codes(issues: ContractIssue[]): string[] {
  return issues.map((entry) => entry.code);
}

describe("contractKind", () => {
  test("HTTP and GraphQL run an exchange, every other driver is schema-only", () => {
    expect(contractKind("http")).toBe("exchange");
    expect(contractKind("graphql")).toBe("exchange");
    expect(contractKind("postgres")).toBe("schema");
    expect(contractKind("s3")).toBe("schema");
    expect(contractKind("mcp")).toBe("schema");
  });
});

describe("scaffoldTemplateContract", () => {
  test("a scaffold of a fixed-host template passes its own check", () => {
    for (const slug of ["airtable", "stripe", "twilio", "browserless", "anthropic", "linear"]) {
      expect({ slug, issues: checkTemplateContract(template(slug), exchange(slug)) }).toEqual({
        slug,
        issues: [],
      });
    }
  });

  test("it probes the declared endpoint and falls back to the root path", () => {
    expect(exchange("airtable").request).toEqual({ method: "GET", path: "/meta/bases" });
    expect(exchange("airtable").expect.url).toBe("https://api.airtable.com/v0/meta/bases");
    expect(exchange("asana").request.path).toBe("/");
  });

  test("a placeholder host gets a synthetic base_url that matches the template", () => {
    const fixture = exchange("shopify");
    expect(fixture.request.base_url).toBe("https://synthetic.myshopify.com/admin/api/2026-04");
    expect(checkTemplateContract(template("shopify"), fixture)).toEqual([]);
  });

  test("a template without a host of its own is placed under example.com", () => {
    const fixture = exchange("http");
    expect(fixture.request.base_url).toBe("https://http.example.com");
    expect(fixture.expect.auth_header).toBeNull();
    expect(checkTemplateContract(template("http"), fixture)).toEqual([]);
  });

  test("a GraphQL scaffold posts a query to the endpoint itself", () => {
    const fixture = exchange("linear");
    expect(fixture.request).toEqual({
      method: "POST",
      path: "",
      body: { query: "query Contract { __typename }" },
    });
    expect(fixture.expect.url).toBe("https://api.linear.app/graphql");
  });

  test("query authentication puts the credential into the expected URL", () => {
    const fixture = exchange("browserless");
    expect(new URL(fixture.expect.url).searchParams.get("token")).toBe(CONTRACT_SECRETS.token);
    expect(fixture.expect.auth_header).toBeNull();
  });

  test("schema-only scaffolds carry the driver config and one value per credential hint", () => {
    expect(scaffoldTemplateContract(template("postgres"))).toEqual({
      connector: { dsn: "postgres://db.example.com:5432/synthetic", config: {} },
      credential: { username: CONTRACT_SECRETS.username, password: CONTRACT_SECRETS.password },
    });
    expect(scaffoldTemplateContract(template("aws-s3"))).toEqual({
      connector: {
        base_url: "https://s3.us-east-1.amazonaws.com",
        config: { bucket: "synthetic-bucket" },
      },
      credential: { value: CONTRACT_SECRETS.token },
    });
    expect(
      checkTemplateContract(template("postgres"), scaffoldTemplateContract(template("postgres"))),
    ).toEqual([]);
    expect(
      checkTemplateContract(template("aws-s3"), scaffoldTemplateContract(template("aws-s3"))),
    ).toEqual([]);
  });

  test("an MCP scaffold declares the transport", () => {
    const mcp = { ...template("http"), driver: "mcp" as const, slug: "synthetic-mcp" };
    const fixture = scaffoldTemplateContract(mcp) as SchemaContract;
    expect(fixture.connector).toEqual({
      base_url: "https://synthetic-mcp.example.com",
      config: { mcp: { transport: "http" } },
    });
    expect(checkTemplateContract(mcp, fixture)).toEqual([]);
  });
});

describe("expectedAuthHeader", () => {
  test("each auth type names where the credential belongs", () => {
    expect(expectedAuthHeader(template("airtable"), null)).toEqual({
      name: "Authorization",
      value: "Bearer synthetic-contract-token",
      match: "exact",
    });
    expect(expectedAuthHeader(template("dropbox"), null)?.value).toBe(
      "Bearer synthetic-contract-token",
    );
    expect(expectedAuthHeader(template("twilio"), null)).toEqual({
      name: "Authorization",
      value: `Basic ${Buffer.from("synthetic-user:synthetic-password").toString("base64")}`,
      match: "exact",
    });
    expect(expectedAuthHeader(template("aws-sqs"), null)).toEqual({
      name: "Authorization",
      value: "AWS4-HMAC-SHA256 Credential=SYNTHETICACCESSKEYID/",
      match: "prefix",
    });
    expect(expectedAuthHeader(template("app-store-connect"), null)).toEqual({
      name: "Authorization",
      value: "Bearer eyJ",
      match: "prefix",
    });
    expect(expectedAuthHeader(template("http"), null)).toBeNull();
    expect(expectedAuthHeader(template("browserless"), null)).toBeNull();
  });

  test("a header template uses its declared name, then the fixture name, then a default", () => {
    expect(expectedAuthHeader(template("anthropic"), null)?.name).toBe("x-api-key");
    expect(
      expectedAuthHeader(template("anthropic"), { name: "other", value: "v", match: "exact" })
        ?.name,
    ).toBe("x-api-key");
    expect(
      expectedAuthHeader(template("supabase"), { name: "apikey", value: "v", match: "exact" }),
    ).toEqual({ name: "apikey", value: CONTRACT_SECRETS.token, match: "exact" });
    expect(expectedAuthHeader(template("supabase"), null)?.name).toBe("X-Api-Key");
  });
});

describe("contractCredential", () => {
  test("builds the credential mode the template authenticates with", () => {
    expect(contractCredential(template("http"), exchange("http"))).toBeNull();
    expect(contractCredential(template("airtable"), exchange("airtable"))).toEqual({
      mode: "bearer",
      token: CONTRACT_SECRETS.token,
    });
    expect(contractCredential(template("dropbox"), exchange("dropbox"))).toEqual({
      mode: "oauth2",
      access_token: CONTRACT_SECRETS.token,
      token_type: "Bearer",
      refresh_token: null,
      expires_at: null,
    });
    expect(contractCredential(template("twilio"), exchange("twilio"))).toEqual({
      mode: "basic",
      username: CONTRACT_SECRETS.username,
      password: CONTRACT_SECRETS.password,
    });
    expect(contractCredential(template("anthropic"), exchange("anthropic"))).toEqual({
      mode: "header",
      headers: { "x-api-key": CONTRACT_SECRETS.token },
    });
    expect(contractCredential(template("browserless"), exchange("browserless"))).toEqual({
      mode: "query",
      query: { token: CONTRACT_SECRETS.token },
    });
    expect(contractCredential(template("aws-sqs"), exchange("aws-sqs"))).toEqual({
      mode: "aws_sigv4",
      access_key_id: CONTRACT_SECRETS.access_key_id,
      secret_access_key: CONTRACT_SECRETS.secret_access_key,
    });
  });

  test("a signed JWT credential exists only with a private key", () => {
    const fixture = exchange("app-store-connect");
    expect(contractCredential(template("app-store-connect"), fixture)).toBeNull();
    expect(contractCredential(template("app-store-connect"), fixture, "pem")).toEqual({
      mode: "signed_jwt",
      private_key: "pem",
    });
  });
});

describe("checkTemplateContract", () => {
  test("rejects a fixture of the wrong shape", () => {
    expect(codes(checkTemplateContract(template("airtable"), { request: {} }))).toContain(
      "fixture_invalid",
    );
    expect(codes(checkTemplateContract(template("postgres"), exchange("airtable")))).toContain(
      "fixture_invalid",
    );
    expect(codes(checkTemplateContract(template("airtable"), null))).toEqual(["fixture_invalid"]);
  });

  test("a fixed-host template refuses another base_url but accepts its own", () => {
    const fixture = exchange("airtable");
    expect(
      codes(
        checkTemplateContract(template("airtable"), {
          ...fixture,
          request: { ...fixture.request, base_url: "https://api.example.com/v0" },
        }),
      ),
    ).toEqual(["base_url_unexpected"]);
    expect(
      checkTemplateContract(template("airtable"), {
        ...fixture,
        request: { ...fixture.request, base_url: "https://api.airtable.com/v0" },
      }),
    ).toEqual([]);
  });

  test("a placeholder or host-less template needs a matching https base_url", () => {
    const shopify = exchange("shopify");
    const withBase = (fixture: ExchangeContract, base_url: string | undefined) => {
      const { base_url: _dropped, ...request } = fixture.request;
      return { ...fixture, request: base_url === undefined ? request : { ...request, base_url } };
    };
    expect(codes(checkTemplateContract(template("shopify"), withBase(shopify, undefined)))).toEqual(
      ["base_url_missing"],
    );
    expect(
      codes(
        checkTemplateContract(
          template("shopify"),
          withBase(shopify, "https://shop.example.com/admin/api/2026-04"),
        ),
      ),
    ).toEqual(["host_mismatch"]);
    expect(
      codes(
        checkTemplateContract(
          template("shopify"),
          withBase(shopify, "http://synthetic.myshopify.com/admin/api/2026-04"),
        ),
      ),
    ).toEqual(["host_mismatch"]);
    expect(
      codes(
        checkTemplateContract(
          template("shopify"),
          withBase(shopify, "https://synthetic.myshopify.com/admin/api/2026-04/extra"),
        ),
      ),
    ).toEqual(["host_mismatch"]);
    const iam = exchange("aws-apigw-iam");
    expect(codes(checkTemplateContract(template("aws-apigw-iam"), iam))).toEqual(["host_mismatch"]);
    expect(
      checkTemplateContract(template("aws-apigw-iam"), {
        ...iam,
        request: {
          ...iam.request,
          base_url: "https://abc123.execute-api.us-east-1.amazonaws.com/prod",
        },
        expect: {
          ...iam.expect,
          url: "https://abc123.execute-api.us-east-1.amazonaws.com/prod/",
        },
      }),
    ).toEqual([]);
    expect(
      codes(
        checkTemplateContract(template("http"), withBase(exchange("http"), "https://api.test.io")),
      ),
    ).toEqual(["host_mismatch"]);
  });

  test("an HTTP path is relative or a URL under the connector base_url", () => {
    const fixture = exchange("jina-reader");
    const withPath = (path: string) => ({ ...fixture, request: { ...fixture.request, path } });
    expect(codes(checkTemplateContract(template("jina-reader"), withPath("items")))).toEqual([
      "request_invalid",
    ]);
    expect(
      codes(checkTemplateContract(template("jina-reader"), withPath("https://example.com/items"))),
    ).toEqual(["request_invalid"]);
    expect(
      checkTemplateContract(
        template("jina-reader"),
        withPath("https://r.jina.ai/https://example.com/"),
      ),
    ).toEqual([]);
  });

  test("a GraphQL contract must post a query to the endpoint", () => {
    const fixture = exchange("linear");
    const withRequest = (request: Partial<ExchangeContract["request"]>) => ({
      ...fixture,
      request: { ...fixture.request, ...request },
    });
    expect(
      codes(checkTemplateContract(template("linear"), withRequest({ method: "GET" }))),
    ).toEqual(["request_invalid"]);
    expect(
      codes(checkTemplateContract(template("linear"), withRequest({ path: "/graphql" }))),
    ).toEqual(["request_invalid"]);
    expect(
      codes(checkTemplateContract(template("linear"), withRequest({ body: { query: 1 } }))),
    ).toEqual(["request_invalid"]);
    expect(codes(checkTemplateContract(template("linear"), withRequest({ body: null })))).toEqual([
      "request_invalid",
    ]);
  });

  test("the response must be a success", () => {
    const fixture = exchange("airtable");
    const withStatus = (status: number) => ({
      ...fixture,
      response: { ...fixture.response, status },
    });
    expect(codes(checkTemplateContract(template("airtable"), withStatus(199)))).toEqual([
      "response_invalid",
    ]);
    expect(codes(checkTemplateContract(template("airtable"), withStatus(300)))).toEqual([
      "response_invalid",
    ]);
    expect(checkTemplateContract(template("airtable"), withStatus(200))).toEqual([]);
    expect(checkTemplateContract(template("airtable"), withStatus(299))).toEqual([]);
  });

  test("the expected URL stays on the connector host and carries the request query", () => {
    const fixture = exchange("airtable");
    const withExpect = (url: string, query?: Record<string, string | number | boolean>) => ({
      ...fixture,
      request: { ...fixture.request, ...(query ? { query } : {}) },
      expect: { ...fixture.expect, url },
    });
    expect(
      codes(
        checkTemplateContract(template("airtable"), withExpect("https://api.example.com/v0/x")),
      ),
    ).toEqual(["url_mismatch"]);
    expect(
      codes(
        checkTemplateContract(
          template("airtable"),
          withExpect("https://api.airtable.com/v0/meta/bases", { limit: 1 }),
        ),
      ),
    ).toEqual(["url_mismatch"]);
    expect(
      checkTemplateContract(
        template("airtable"),
        withExpect("https://api.airtable.com/v0/meta/bases?limit=1", { limit: 1 }),
      ),
    ).toEqual([]);
  });

  test("the credential may be in the URL only for query authentication", () => {
    const bearer = exchange("airtable");
    expect(
      codes(
        checkTemplateContract(template("airtable"), {
          ...bearer,
          expect: { ...bearer.expect, url: `${bearer.expect.url}?t=${CONTRACT_SECRETS.token}` },
        }),
      ),
    ).toEqual(["secret_in_url"]);
    const query = exchange("browserless");
    expect(
      codes(
        checkTemplateContract(template("browserless"), {
          ...query,
          expect: { ...query.expect, url: "https://production-sfo.browserless.io/" },
        }),
      ),
    ).toEqual(["auth_mismatch"]);
  });

  test("the expected auth header must be the one the auth type produces", () => {
    const fixture = exchange("airtable");
    const withAuth = (auth_header: ExchangeContract["expect"]["auth_header"]) => ({
      ...fixture,
      expect: { ...fixture.expect, auth_header },
    });
    expect(codes(checkTemplateContract(template("airtable"), withAuth(null)))).toEqual([
      "auth_mismatch",
    ]);
    expect(
      codes(
        checkTemplateContract(
          template("airtable"),
          withAuth({ name: "Authorization", value: "Bearer other", match: "exact" }),
        ),
      ),
    ).toEqual(["auth_mismatch"]);
    expect(
      codes(
        checkTemplateContract(
          template("airtable"),
          withAuth({ name: "X-Token", value: "Bearer synthetic-contract-token", match: "exact" }),
        ),
      ),
    ).toEqual(["auth_mismatch"]);
    expect(
      codes(
        checkTemplateContract(
          template("airtable"),
          withAuth({
            name: "Authorization",
            value: "Bearer synthetic-contract-token",
            match: "prefix",
          }),
        ),
      ),
    ).toEqual(["auth_mismatch"]);
    expect(
      checkTemplateContract(
        template("airtable"),
        withAuth({
          name: "authorization",
          value: "Bearer synthetic-contract-token",
          match: "exact",
        }),
      ),
    ).toEqual([]);
    const open = exchange("http");
    const issues = checkTemplateContract(template("http"), {
      ...open,
      expect: { ...open.expect, auth_header: { name: "Authorization", value: "x" } },
    });
    expect(issues).toEqual([
      {
        code: "auth_mismatch",
        message: "auth_type none sends no auth header; expect.auth_header must be null",
      },
    ]);
  });

  test("a probe path that repeats the base path is reported", () => {
    const repeated = {
      ...template("airtable"),
      probe_endpoint: { method: "GET" as const, path: "/v0/meta/bases", description: "" },
    };
    expect(codes(checkTemplateContract(repeated, exchange("airtable")))).toEqual([
      "probe_path_repeats_base",
    ]);
    const rooted = { ...template("github"), probe_endpoint: null };
    expect(checkTemplateContract(rooted, exchange("github"))).toEqual([]);
  });

  test("only example.com email addresses count as synthetic", () => {
    const fixture = exchange("airtable");
    const withBody = (body: unknown) => ({ ...fixture, response: { ...fixture.response, body } });
    expect(
      codes(checkTemplateContract(template("airtable"), withBody({ email: "jane@corp.io" }))),
    ).toEqual(["not_synthetic"]);
    expect(
      checkTemplateContract(
        template("airtable"),
        withBody({ a: "user@example.com", b: "user@mail.example.org" }),
      ),
    ).toEqual([]);
    expect(
      codes(
        checkTemplateContract(template("postgres"), {
          connector: { dsn: "postgres://db.example.com/x", config: {} },
          credential: { username: "jane@corp.io", password: "synthetic" },
        }),
      ),
    ).toEqual(["not_synthetic"]);
  });

  test("a schema-only contract validates address and credential fields", () => {
    const s3 = scaffoldTemplateContract(template("aws-s3")) as SchemaContract;
    expect(
      codes(
        checkTemplateContract(template("aws-s3"), {
          ...s3,
          connector: { ...s3.connector, base_url: "https://storage.example.com" },
        }),
      ),
    ).toEqual(["host_mismatch"]);
    expect(codes(checkTemplateContract(template("aws-s3"), { ...s3, credential: {} }))).toEqual([
      "credential_mismatch",
    ]);
    expect(
      codes(
        checkTemplateContract(template("aws-s3"), {
          ...s3,
          credential: { value: "v", extra: "x" },
        }),
      ),
    ).toEqual(["credential_mismatch"]);
    const pg = scaffoldTemplateContract(template("postgres")) as SchemaContract;
    expect(
      codes(
        checkTemplateContract(template("postgres"), {
          ...pg,
          connector: {
            config: {},
            dsn: "postgres://synthetic-user:synthetic-password@db.example.com/x",
          },
        }),
      ),
    ).toEqual(["secret_in_url", "secret_in_url"]);
    expect(
      codes(
        checkTemplateContract(template("postgres"), {
          ...pg,
          connector: { config: {} },
        }),
      ),
    ).toEqual(["host_mismatch"]);
    expect(
      checkTemplateContract(template("postgres"), {
        ...pg,
        credential: { username: "", password: "" },
      }),
    ).toEqual([]);
    const bare = { ...template("aws-s3"), url_pattern: null };
    expect(checkTemplateContract(bare, s3)).toEqual([]);
    const hostless = { ...bare, base_url: null };
    expect(checkTemplateContract(hostless, s3)).toEqual([]);
    expect(
      codes(
        checkTemplateContract(hostless, {
          ...s3,
          connector: { config: s3.connector.config },
        }),
      ),
    ).toEqual(["host_mismatch"]);
  });
});
