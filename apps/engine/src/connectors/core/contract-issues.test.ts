import { describe, expect, test } from "bun:test";
import { type ConnectorTemplate, getBuiltinTemplate } from "../templates.ts";
import {
  CONTRACT_SECRETS,
  type ContractIssue,
  checkTemplateContract,
  contractCredential,
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

function withBaseUrl(fixture: ExchangeContract, base_url: string | undefined): ExchangeContract {
  const { base_url: _dropped, ...request } = fixture.request;
  return { ...fixture, request: base_url === undefined ? request : { ...request, base_url } };
}

function withRequest(
  fixture: ExchangeContract,
  request: Partial<ExchangeContract["request"]>,
): ExchangeContract {
  return { ...fixture, request: { ...fixture.request, ...request } };
}

function withExpect(
  fixture: ExchangeContract,
  expectChange: Partial<ExchangeContract["expect"]>,
): ExchangeContract {
  return { ...fixture, expect: { ...fixture.expect, ...expectChange } };
}

const hint = template("browserless")
  .credential_hints[0] as ConnectorTemplate["credential_hints"][number];
const queryWithoutName: ConnectorTemplate = { ...template("browserless"), auth_options: [] };

describe("ExchangeContractSchema", () => {
  test.each(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"])(
    "accepts the %s method",
    (method) => {
      const fixture = scaffoldTemplateContract(template("airtable")) as ExchangeContract;
      expect(
        ExchangeContractSchema.safeParse({ ...fixture, request: { ...fixture.request, method } })
          .success,
      ).toBe(true);
    },
  );
});

describe("fixture_invalid issues", () => {
  test("a fixture that is no object is named as the fixture", () => {
    expect(checkTemplateContract(template("airtable"), null)).toEqual([
      {
        code: "fixture_invalid",
        message: "fixture: Invalid input: expected object, received null",
      },
    ]);
  });

  test("a nested problem is named by its dotted path", () => {
    const fixture = exchange("airtable");
    const issues = checkTemplateContract(template("airtable"), {
      ...fixture,
      response: { headers: {}, body: null },
    });
    expect(issues).toEqual([
      {
        code: "fixture_invalid",
        message: "response.status: Invalid input: expected number, received undefined",
      },
    ]);
  });
});

describe("base_url issues", () => {
  test("a fixed host names the template and the host", () => {
    const fixture = exchange("airtable");
    expect(
      checkTemplateContract(
        template("airtable"),
        withRequest(fixture, { base_url: "https://api.example.com/v0" }),
      ),
    ).toEqual([
      {
        code: "base_url_unexpected",
        message:
          'template "airtable" has the fixed base_url https://api.airtable.com/v0; the fixture must not declare another one',
      },
    ]);
  });

  test("a placeholder host asks for a base_url", () => {
    expect(
      checkTemplateContract(template("shopify"), withBaseUrl(exchange("shopify"), undefined)),
    ).toEqual([
      {
        code: "base_url_missing",
        message:
          'template "shopify" has no fixed base_url; the fixture must declare request.base_url',
      },
    ]);
  });

  test("a base_url must use https even when the template has no host of its own", () => {
    expect(
      checkTemplateContract(
        template("http"),
        withBaseUrl(exchange("http"), "http://api.example.com"),
      ),
    ).toEqual([
      { code: "host_mismatch", message: "base_url http://api.example.com must use https" },
    ]);
  });

  test("a base_url that misses the template pattern names the base_url", () => {
    expect(
      checkTemplateContract(
        template("shopify"),
        withBaseUrl(exchange("shopify"), "https://shop.example.com/admin/api/2026-04"),
      ),
    ).toEqual([
      {
        code: "host_mismatch",
        message:
          "base_url https://shop.example.com/admin/api/2026-04 does not match the template base_url https://{shop}.myshopify.com/admin/api/2026-04",
      },
    ]);
  });

  test("a base_url that misses the url_pattern names the pattern", () => {
    expect(checkTemplateContract(template("aws-apigw-iam"), exchange("aws-apigw-iam"))).toEqual([
      {
        code: "host_mismatch",
        message:
          "base_url https://aws-apigw-iam.example.com does not match the template url_pattern ^https:\\/\\/[a-z0-9]+\\.execute-api\\.[a-z0-9-]+\\.amazonaws\\.com\\/.*$",
      },
    ]);
  });

  test("a template without a host accepts only example.com hosts", () => {
    const refused = (base: string) =>
      checkTemplateContract(template("http"), withBaseUrl(exchange("http"), base));
    expect(refused("https://api.test.io")).toEqual([
      {
        code: "host_mismatch",
        message:
          'template "http" has no host of its own; base_url https://api.test.io must be under example.com',
      },
    ]);
    expect(codes(refused("https://example.com.evil.io"))).toEqual(["host_mismatch"]);
    expect(codes(refused("https://myexample.com"))).toEqual(["host_mismatch"]);
    expect(codes(refused("https://example.com"))).not.toContain("host_mismatch");
    expect(codes(refused("https://api.example.org"))).not.toContain("host_mismatch");
  });
});

describe("authentication parameter and header names", () => {
  const withHints = (hints: Array<Partial<typeof hint>>): ConnectorTemplate => ({
    ...template("anthropic"),
    auth_options: [],
    credential_hints: hints.map((entry) => ({ ...hint, ...entry })),
  });

  test("a header template falls back to the credential hint that names a header", () => {
    expect(expectedAuthHeader(withHints([{ header_name: "X-Custom" }]), null)?.name).toBe(
      "X-Custom",
    );
    expect(
      expectedAuthHeader(
        withHints([{ field: "first" }, { field: "second", header_name: "X-Second" }]),
        null,
      )?.name,
    ).toBe("X-Second");
    expect(expectedAuthHeader(withHints([{ field: "first" }]), null)?.name).toBe("X-Api-Key");
  });

  test("only the option of the template's own auth type names the parameter", () => {
    const wrongOption = {
      auth_type: "bearer" as const,
      label: "Bearer",
      description: "Bearer token",
      param_name: "wrong",
    };
    const template2: ConnectorTemplate = {
      ...template("browserless"),
      auth_options: [wrongOption, ...template("browserless").auth_options],
    };
    expect(contractCredential(template2, exchange("browserless"))).toEqual({
      mode: "query",
      query: { token: CONTRACT_SECRETS.token },
    });
  });

  test("a query template without a declared name uses api_key", () => {
    const fixture = ExchangeContractSchema.parse(scaffoldTemplateContract(queryWithoutName));
    expect(contractCredential(queryWithoutName, fixture)).toEqual({
      mode: "query",
      query: { api_key: CONTRACT_SECRETS.token },
    });
    expect(new URL(fixture.expect.url).searchParams.get("api_key")).toBe(CONTRACT_SECRETS.token);
    expect(checkTemplateContract(queryWithoutName, fixture)).toEqual([]);
    expect(
      checkTemplateContract(
        queryWithoutName,
        withExpect(fixture, { url: "https://production-sfo.browserless.io/" }),
      ),
    ).toEqual([
      { code: "auth_mismatch", message: "expect.url must carry the credential as api_key" },
    ]);
  });
});

describe("request and response issues", () => {
  test("a GraphQL contract that is not a POST of a query to the endpoint", () => {
    expect(
      checkTemplateContract(template("linear"), withRequest(exchange("linear"), { method: "GET" })),
    ).toEqual([
      {
        code: "request_invalid",
        message:
          'a GraphQL contract posts to the endpoint itself: method POST, path "" and body.query',
      },
    ]);
  });

  test("an HTTP path that is neither relative nor under the base_url", () => {
    const fixture = exchange("jina-reader");
    expect(
      checkTemplateContract(template("jina-reader"), withRequest(fixture, { path: "items" })),
    ).toEqual([
      {
        code: "request_invalid",
        message: 'request.path items must start with "/" or be a URL under the connector base_url',
      },
    ]);
  });

  test("a URL path under the base_url is accepted whatever the trailing slashes of the base_url", () => {
    const open = exchange("http");
    const onBase = (base: string, path: string) =>
      checkTemplateContract(
        template("http"),
        withExpect(withRequest(open, { base_url: base, path }), { url: path }),
      );
    expect(onBase("https://api.example.com//", "https://api.example.com/items")).toEqual([]);
    expect(onBase("https://api.example.com/", "https://api.example.com/items")).toEqual([]);
    expect(onBase("https://api.example.com", "https://api.example.com/items")).toEqual([]);
    expect(
      codes(onBase("https://api.example.com", "https://api.example.com.evil.io/items")),
    ).toEqual(["request_invalid"]);
    expect(codes(onBase("https://api.example.com", "https://api.example.comitems"))).toEqual([
      "request_invalid",
    ]);
  });

  test("without a base_url an unrooted path is invalid on top of the missing base_url", () => {
    const fixture = withRequest(withBaseUrl(exchange("shopify"), undefined), { path: "items" });
    expect(codes(checkTemplateContract(template("shopify"), fixture))).toEqual([
      "base_url_missing",
      "request_invalid",
    ]);
  });

  test("a failing status names itself", () => {
    const fixture = exchange("airtable");
    expect(
      checkTemplateContract(template("airtable"), {
        ...fixture,
        response: { ...fixture.response, status: 199 },
      }),
    ).toEqual([
      { code: "response_invalid", message: "response.status 199 must be a success status" },
    ]);
  });

  test("the URL checks wait until the request and response are valid", () => {
    const fixture = exchange("airtable");
    expect(
      checkTemplateContract(
        template("airtable"),
        withExpect(
          { ...fixture, response: { ...fixture.response, status: 300 } },
          { url: "https://api.example.com/v0/x" },
        ),
      ),
    ).toEqual([
      { code: "response_invalid", message: "response.status 300 must be a success status" },
    ]);
  });
});

describe("expected URL issues", () => {
  const fixture = exchange("airtable");

  test("another host names the URL and the connector host", () => {
    expect(
      checkTemplateContract(
        template("airtable"),
        withExpect(fixture, { url: "https://api.example.com/v0/x" }),
      ),
    ).toEqual([
      {
        code: "url_mismatch",
        message:
          "expect.url https://api.example.com/v0/x is not on the connector host https://api.airtable.com/v0",
      },
    ]);
  });

  test("a missing request query parameter is named", () => {
    expect(
      checkTemplateContract(
        template("airtable"),
        withExpect(withRequest(fixture, { query: { limit: 1 } }), { url: fixture.expect.url }),
      ),
    ).toEqual([
      { code: "url_mismatch", message: "expect.url does not carry the query parameter limit" },
    ]);
  });

  test("a query credential missing from the URL names the parameter", () => {
    const query = exchange("browserless");
    expect(
      checkTemplateContract(
        template("browserless"),
        withExpect(query, { url: "https://production-sfo.browserless.io/" }),
      ),
    ).toEqual([
      { code: "auth_mismatch", message: "expect.url must carry the credential as token" },
    ]);
  });

  test("a credential in the URL of a header-authenticated template is refused", () => {
    expect(
      checkTemplateContract(
        template("airtable"),
        withExpect(fixture, { url: `${fixture.expect.url}?t=${CONTRACT_SECRETS.token}` }),
      ),
    ).toEqual([{ code: "secret_in_url", message: "expect.url must not carry the credential" }]);
  });
});

describe("auth header issues", () => {
  test("an exact match names the header and the value", () => {
    const fixture = exchange("airtable");
    expect(
      checkTemplateContract(template("airtable"), withExpect(fixture, { auth_header: null })),
    ).toEqual([
      {
        code: "auth_mismatch",
        message:
          'auth_type bearer expects Authorization to equal "Bearer synthetic-contract-token"',
      },
    ]);
  });

  test("a prefix match says start with", () => {
    const fixture = exchange("aws-sqs");
    expect(
      checkTemplateContract(template("aws-sqs"), withExpect(fixture, { auth_header: null })),
    ).toEqual([
      {
        code: "auth_mismatch",
        message:
          'auth_type aws_sigv4 expects Authorization to start with "AWS4-HMAC-SHA256 Credential=SYNTHETICACCESSKEYID/"',
      },
    ]);
  });
});

describe("probe path issues", () => {
  const rooted = (path: string): ConnectorTemplate => ({
    ...template("http"),
    base_url: "https://api.example.com/v1",
    probe_endpoint: { method: "GET", path, description: "" },
  });
  const check = (candidate: ConnectorTemplate) =>
    checkTemplateContract(
      candidate,
      ExchangeContractSchema.parse(scaffoldTemplateContract(candidate)),
    );

  test("a repeated base path names the path, the segment and the base_url", () => {
    expect(check(rooted("/v1/items"))).toEqual([
      {
        code: "probe_path_repeats_base",
        message:
          'probe_endpoint.path /v1/items repeats "v1" from the base_url https://api.example.com/v1',
      },
    ]);
  });

  test("the scheme and the host of the base_url are not part of its path", () => {
    expect(check(rooted("/https:/items"))).toEqual([]);
    expect(check(rooted("/api.example.com/items"))).toEqual([]);
    expect(check(rooted("/pi.example.com/items"))).toEqual([]);
    expect(check(rooted("/items"))).toEqual([]);
  });

  test("a template without a base_url has nothing to repeat", () => {
    const hostless: ConnectorTemplate = {
      ...template("http"),
      probe_endpoint: { method: "GET", path: "/items", description: "" },
    };
    expect(check(hostless)).toEqual([]);
  });
});

describe("synthetic data issues", () => {
  const fixture = exchange("airtable");
  const withBody = (body: unknown) => ({ ...fixture, response: { ...fixture.response, body } });

  test("the whole address is named, with its full local part", () => {
    expect(
      checkTemplateContract(template("airtable"), withBody({ email: "jane.doe+tag@corp.io" })),
    ).toEqual([
      {
        code: "not_synthetic",
        message: "email address jane.doe+tag@corp.io must use an example.com address",
      },
    ]);
  });

  test("a host that merely starts with example.com is not synthetic", () => {
    expect(
      codes(
        checkTemplateContract(template("airtable"), withBody({ email: "a@example.com.evil.io" })),
      ),
    ).toEqual(["not_synthetic"]);
    expect(
      codes(checkTemplateContract(template("airtable"), withBody({ email: "a@myexample.com" }))),
    ).toEqual(["not_synthetic"]);
  });
});

describe("schema-only issues", () => {
  const s3 = scaffoldTemplateContract(template("aws-s3")) as SchemaContract;
  const pg = scaffoldTemplateContract(template("postgres")) as SchemaContract;

  test("an address that differs from the fixed base_url is named", () => {
    const bare: ConnectorTemplate = { ...template("aws-s3"), url_pattern: null };
    expect(
      checkTemplateContract(bare, {
        ...s3,
        connector: { ...s3.connector, base_url: "https://storage.example.com" },
      }),
    ).toEqual([
      {
        code: "host_mismatch",
        message: 'connector address "https://storage.example.com" does not match template "aws-s3"',
      },
    ]);
  });

  test("the credential fields are listed sorted next to the template hints", () => {
    expect(
      checkTemplateContract(template("postgres"), { ...pg, credential: { b: "qq", a: "zz" } }),
    ).toEqual([
      {
        code: "credential_mismatch",
        message: "credential fields [a, b] differ from the template hints [password, username]",
      },
    ]);
  });

  test("a credential inside the address is refused", () => {
    expect(
      checkTemplateContract(template("postgres"), {
        ...pg,
        connector: { config: {}, dsn: "postgres://synthetic-user@db.example.com/x" },
      }),
    ).toEqual([
      { code: "secret_in_url", message: "the connector address must not carry a credential" },
    ]);
  });
});

describe("scaffold details", () => {
  test("an HTTP scaffold answers 200 with JSON and expects that output", () => {
    const fixture = exchange("airtable");
    expect(fixture.response).toEqual({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { ok: true },
    });
    expect(fixture.expect.output).toEqual({ ok: true });
  });

  test("a GraphQL scaffold answers with a typename", () => {
    const fixture = exchange("linear");
    expect(fixture.response).toEqual({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { data: { __typename: "Query" } },
    });
    expect(fixture.expect.output).toEqual({ data: { __typename: "Query" } });
  });

  test("trailing slashes of the base_url do not reach the expected URL", () => {
    const slashed: ConnectorTemplate = {
      ...template("airtable"),
      base_url: "https://api.example.com/v0//",
    };
    expect(exchange("airtable").expect.url).toBe("https://api.airtable.com/v0/meta/bases");
    expect((scaffoldTemplateContract(slashed) as ExchangeContract).expect.url).toBe(
      "https://api.example.com/v0/meta/bases",
    );
  });

  test("a schema-only driver without defaults gets an empty config", () => {
    const fixture = scaffoldTemplateContract(template("sftp")) as SchemaContract;
    expect(fixture.connector.config).toEqual({});
  });
});
