import { describe, expect, test } from "bun:test";
import { getBuiltinTemplate } from "../templates.ts";
import {
  CONTRACT_SECRETS,
  type ContractIssue,
  checkContractExchange,
  contractBaseUrl,
  contractCredential,
  type ExchangeContract,
  ExchangeContractSchema,
  type ObservedExchange,
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

function observed(fixture: ExchangeContract, change: Partial<ObservedExchange> = {}) {
  const auth = fixture.expect.auth_header;
  const body = fixture.request.body;
  return {
    requests: [
      {
        method: fixture.request.method,
        url: fixture.expect.url,
        headers: auth ? { [auth.name.toLowerCase()]: `${auth.value}tail` } : {},
        body: body === undefined ? null : JSON.stringify({ ...(body as object), variables: {} }),
      },
    ],
    output: fixture.expect.output,
    ...change,
  } satisfies ObservedExchange;
}

function exact(fixture: ExchangeContract): ObservedExchange {
  const base = observed(fixture);
  const auth = fixture.expect.auth_header;
  const first = base.requests[0];
  if (!first) throw new Error("no request");
  return {
    ...base,
    requests: [{ ...first, headers: auth ? { [auth.name.toLowerCase()]: auth.value } : {} }],
  };
}

describe("contractBaseUrl", () => {
  test("prefers the fixed template host over the fixture", () => {
    const fixture = exchange("airtable");
    expect(contractBaseUrl(template("airtable"), fixture)).toBe("https://api.airtable.com/v0");
    expect(contractBaseUrl(template("shopify"), exchange("shopify"))).toBe(
      "https://synthetic.myshopify.com/admin/api/2026-04",
    );
    expect(contractBaseUrl(template("shopify"), fixture)).toBeNull();
  });
});

describe("checkContractExchange", () => {
  const bearer = () => exchange("airtable");
  const credential = (slug: string, fixture: ExchangeContract) =>
    contractCredential(template(slug), fixture);

  test("a faithful exchange has no issues", () => {
    for (const slug of ["airtable", "twilio", "anthropic", "browserless", "http", "linear"]) {
      const fixture = exchange(slug);
      expect({
        slug,
        issues: checkContractExchange(
          template(slug),
          fixture,
          exact(fixture),
          credential(slug, fixture),
        ),
      }).toEqual({ slug, issues: [] });
    }
  });

  test("a prefix match accepts a longer header value and rejects another one", () => {
    const fixture = exchange("aws-sqs");
    const creds = credential("aws-sqs", fixture);
    expect(checkContractExchange(template("aws-sqs"), fixture, observed(fixture), creds)).toEqual(
      [],
    );
    const first = observed(fixture).requests[0];
    expect(
      codes(
        checkContractExchange(
          template("aws-sqs"),
          fixture,
          { ...observed(fixture), requests: [{ ...first!, headers: { authorization: "AWS4" } }] },
          creds,
        ),
      ),
    ).toEqual(["auth_misplaced"]);
  });

  test("an exact match rejects a longer header value", () => {
    const fixture = bearer();
    expect(
      codes(
        checkContractExchange(
          template("airtable"),
          fixture,
          observed(fixture),
          credential("airtable", fixture),
        ),
      ),
    ).toEqual(["auth_misplaced"]);
  });

  test("a request to another host is an escape", () => {
    const fixture = bearer();
    const first = exact(fixture).requests[0]!;
    const issues = checkContractExchange(
      template("airtable"),
      fixture,
      {
        output: fixture.expect.output,
        requests: [first, { ...first, url: "https://collector.example.net/meta/bases" }],
      },
      credential("airtable", fixture),
    );
    expect(issues).toEqual([
      {
        code: "host_escape",
        message: "a request left the connector host: https://collector.example.net/meta/bases",
      },
      { code: "request_count", message: "expected exactly one request, saw 2" },
    ]);
  });

  test("no request at all is reported once", () => {
    const fixture = bearer();
    expect(
      checkContractExchange(
        template("airtable"),
        fixture,
        { requests: [], output: fixture.expect.output },
        credential("airtable", fixture),
      ),
    ).toEqual([{ code: "request_count", message: "expected exactly one request, saw 0" }]);
  });

  test("URL and method are compared with the fixture", () => {
    const fixture = bearer();
    const first = exact(fixture).requests[0]!;
    expect(
      codes(
        checkContractExchange(
          template("airtable"),
          fixture,
          {
            output: fixture.expect.output,
            requests: [{ ...first, url: `${first.url}/other`, method: "post" }],
          },
          credential("airtable", fixture),
        ),
      ),
    ).toEqual(["url_mismatch", "method_mismatch"]);
    expect(
      checkContractExchange(
        template("airtable"),
        fixture,
        { output: fixture.expect.output, requests: [{ ...first, method: "get" }] },
        credential("airtable", fixture),
      ),
    ).toEqual([]);
  });

  test("a missing credential and an unexpected Authorization header are both misplaced", () => {
    const fixture = bearer();
    const first = exact(fixture).requests[0]!;
    expect(
      codes(
        checkContractExchange(
          template("airtable"),
          fixture,
          { output: fixture.expect.output, requests: [{ ...first, headers: {} }] },
          credential("airtable", fixture),
        ),
      ),
    ).toEqual(["auth_misplaced"]);
    const open = exchange("http");
    const sent = exact(open).requests[0]!;
    expect(
      checkContractExchange(
        template("http"),
        open,
        { output: open.expect.output, requests: [{ ...sent, headers: { Authorization: "x" } }] },
        null,
      ),
    ).toEqual([
      {
        code: "auth_misplaced",
        message: "an Authorization header was sent but none is expected",
      },
    ]);
  });

  test("the credential must not appear in the URL, the body or another header", () => {
    const fixture = bearer();
    const first = exact(fixture).requests[0]!;
    const leak = (change: Partial<typeof first>) =>
      checkContractExchange(
        template("airtable"),
        { ...fixture, expect: { ...fixture.expect, url: change.url ?? fixture.expect.url } },
        { output: fixture.expect.output, requests: [{ ...first, ...change }] },
        credential("airtable", fixture),
      );
    expect(leak({ url: `${first.url}?t=${CONTRACT_SECRETS.token}` })).toEqual([
      { code: "secret_leak", message: "the credential appears in the request URL" },
    ]);
    expect(codes(leak({ body: `{"t":"${CONTRACT_SECRETS.token}"}` }))).toEqual([
      "secret_leak",
      "body_mismatch",
    ]);
    expect(
      leak({ headers: { ...first.headers, "X-Debug": `t=${CONTRACT_SECRETS.token}` } }),
    ).toEqual([{ code: "secret_leak", message: "the credential appears in the x-debug header" }]);
  });

  test("a query credential belongs in the URL", () => {
    const fixture = exchange("browserless");
    expect(
      checkContractExchange(
        template("browserless"),
        fixture,
        exact(fixture),
        credential("browserless", fixture),
      ),
    ).toEqual([]);
  });

  test("basic authentication guards the password and its encoded form", () => {
    const fixture = exchange("twilio");
    const first = exact(fixture).requests[0]!;
    const encoded = Buffer.from("synthetic-user:synthetic-password").toString("base64");
    expect(
      codes(
        checkContractExchange(
          template("twilio"),
          fixture,
          {
            output: fixture.expect.output,
            requests: [
              {
                ...first,
                headers: { ...first.headers, "x-a": encoded, "x-b": "synthetic-password" },
              },
            ],
          },
          credential("twilio", fixture),
        ),
      ),
    ).toEqual(["secret_leak", "secret_leak"]);
  });

  test("other credential modes guard their secret", () => {
    const first = (fixture: ExchangeContract) => exact(fixture).requests[0]!;
    const check = (slug: string, secret: string, key?: string) => {
      const fixture = exchange(slug);
      const sent = first(fixture);
      return codes(
        checkContractExchange(
          template(slug),
          fixture,
          {
            output: fixture.expect.output,
            requests: [{ ...sent, headers: { ...sent.headers, "x-copy": secret } }],
          },
          contractCredential(template(slug), fixture, key),
        ),
      );
    };
    expect(check("dropbox", CONTRACT_SECRETS.token)).toEqual(["secret_leak"]);
    expect(check("anthropic", CONTRACT_SECRETS.token)).toEqual(["secret_leak"]);
    expect(check("aws-sqs", CONTRACT_SECRETS.secret_access_key)).toEqual(["secret_leak"]);
    expect(check("aws-sqs", CONTRACT_SECRETS.access_key_id)).toEqual([]);
    expect(check("app-store-connect", "pem-material", "pem-material")).toEqual(["secret_leak"]);
    expect(check("http", CONTRACT_SECRETS.token)).toEqual([]);
  });

  test("a credential mode without a secret of its own guards nothing", () => {
    const fixture = exchange("http");
    const sent = exact(fixture).requests[0]!;
    expect(
      checkContractExchange(
        template("http"),
        fixture,
        { output: fixture.expect.output, requests: [{ ...sent, headers: { "x-copy": "none" } }] },
        { mode: "none" },
      ),
    ).toEqual([]);
  });

  test("the request body is compared structurally, as text, or must be absent", () => {
    const fixture = { ...bearer(), request: { ...bearer().request, method: "POST" as const } };
    const first = { ...exact(fixture).requests[0]!, method: "POST" };
    const run = (body: unknown, sent: string | null) =>
      codes(
        checkContractExchange(
          template("airtable"),
          { ...fixture, request: { ...fixture.request, ...(body === undefined ? {} : { body }) } },
          { output: fixture.expect.output, requests: [{ ...first, body: sent }] },
          credential("airtable", fixture),
        ),
      );
    expect(run({ a: 1, b: [1, { c: null }] }, '{"b":[1,{"c":null}],"a":1}')).toEqual([]);
    expect(run({ a: 1 }, '{"a":2}')).toEqual(["body_mismatch"]);
    expect(run({ a: 1 }, null)).toEqual(["body_mismatch"]);
    expect(run({ a: [1, 2] }, '{"a":[2,1]}')).toEqual(["body_mismatch"]);
    expect(run("a=1&b=2", "a=1&b=2")).toEqual([]);
    expect(run("a=1&b=2", "a=1")).toEqual(["body_mismatch"]);
    expect(run({ a: 1 }, "not json")).toEqual(["body_mismatch"]);
    expect(run(undefined, null)).toEqual([]);
    expect(run(undefined, "")).toEqual([]);
    expect(run(null, null)).toEqual([]);
    expect(run(undefined, "{}")).toEqual(["body_mismatch"]);
  });

  test("a GraphQL body may omit empty variables", () => {
    const fixture = exchange("linear");
    const first = exact(fixture).requests[0]!;
    const creds = credential("linear", fixture);
    expect(checkContractExchange(template("linear"), fixture, exact(fixture), creds)).toEqual([]);
    expect(
      codes(
        checkContractExchange(
          template("linear"),
          fixture,
          {
            output: fixture.expect.output,
            requests: [
              { ...first, body: '{"query":"query Contract { __typename }","variables":{"id":1}}' },
            ],
          },
          creds,
        ),
      ),
    ).toEqual(["body_mismatch"]);
  });

  test("the driver output is compared with expect.output", () => {
    const fixture = bearer();
    expect(
      checkContractExchange(
        template("airtable"),
        fixture,
        { ...exact(fixture), output: { ok: false } },
        credential("airtable", fixture),
      ),
    ).toEqual([
      { code: "output_mismatch", message: "the driver output differs from expect.output" },
    ]);
    const empty = { ...fixture, expect: { ...fixture.expect, output: null } };
    expect(
      checkContractExchange(
        template("airtable"),
        empty,
        { ...exact(fixture), output: undefined },
        credential("airtable", fixture),
      ),
    ).toEqual([]);
  });
});
