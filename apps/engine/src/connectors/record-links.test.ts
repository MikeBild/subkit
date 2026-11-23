import { describe, expect, test } from "bun:test";
import { deriveRecordLinks, RECORD_LINK_LIMIT, type RecordLinkStep } from "./record-links.ts";
import { type ConnectorTemplate, getBuiltinTemplate } from "./templates.ts";

const CONNECTOR = "00000000-0000-4000-8000-000000000001";

function template(slug: string): ConnectorTemplate {
  const found = getBuiltinTemplate(slug);
  if (!found) throw new Error(`missing template ${slug}`);
  return found;
}

function httpStep(
  method: string,
  url: string,
  output: unknown,
  overrides: Partial<RecordLinkStep> = {},
  base_url: string | null = null,
): RecordLinkStep {
  return {
    step_key: "write",
    kind: "request",
    status: "succeeded",
    held: false,
    output_preview: output,
    request_meta: {
      driver: "http",
      method,
      url,
      status: 201,
      connector: { connector_id: CONNECTOR, connector_slug: "mine", base_url },
    },
    redacted_fields: [],
    result_storage_uri: null,
    ...overrides,
  };
}

function links(slug: string, steps: RecordLinkStep[]) {
  return deriveRecordLinks(steps, (id) => (id === CONNECTOR ? template(slug) : null));
}

const issue = {
  number: 42,
  html_url: "https://github.com/acme/app/issues/42",
  url: "https://api.github.com/repos/acme/app/issues/42",
};

describe("record links from request steps", () => {
  test("a created issue links to the URL the response already carries", () => {
    expect(
      links("github", [httpStep("POST", "https://api.github.com/repos/acme/app/issues", issue)]),
    ).toEqual([
      {
        label: "acme/app#42",
        url: "https://github.com/acme/app/issues/42",
        connector: "github",
        connector_name: "GitHub",
        step_key: "write",
      },
    ]);
  });

  test("without a web URL in the response the template builds it from path and response", () => {
    const [link] = links("github", [
      httpStep("POST", "https://api.github.com/repos/acme/app/issues", { number: 7 }),
    ]);
    expect(link?.url).toBe("https://github.com/acme/app/issues/7");
  });

  test("a read or an unmatched path yields no link", () => {
    expect(
      links("github", [httpStep("GET", "https://api.github.com/repos/acme/app/issues", issue)]),
    ).toEqual([]);
    expect(links("github", [httpStep("POST", "https://api.github.com/gists", issue)])).toEqual([]);
  });

  test("the base path is stripped and host placeholders fill the web URL", () => {
    const [link] = links("shopify", [
      httpStep(
        "POST",
        "https://acme-store.myshopify.com/admin/api/2026-04/products.json",
        { product: { id: 632910392, title: "Mug" } },
        {},
        "https://acme-store.myshopify.com/admin/api/2026-04",
      ),
    ]);
    expect(link).toMatchObject({
      url: "https://admin.shopify.com/store/acme-store/products/632910392",
      label: "Mug",
    });
  });

  test("a condition picks the matching dashboard mode", () => {
    const url = "https://api.stripe.com/v1/customers";
    expect(links("stripe", [httpStep("POST", url, { id: "cus_1", livemode: false })])[0]?.url).toBe(
      "https://dashboard.stripe.com/test/customers/cus_1",
    );
    expect(links("stripe", [httpStep("POST", url, { id: "cus_1", livemode: true })])[0]?.url).toBe(
      "https://dashboard.stripe.com/customers/cus_1",
    );
  });

  test("a GraphQL mutation links through the response root", () => {
    const step: RecordLinkStep = {
      ...httpStep("POST", "", null),
      request_meta: {
        driver: "graphql",
        method: "POST",
        status: 200,
        connector: { connector_id: CONNECTOR, connector_slug: "linear" },
      },
      output_preview: {
        issueCreate: {
          issue: { identifier: "ENG-12", url: "https://linear.app/acme/issue/ENG-12" },
        },
      },
    };
    expect(links("linear", [step])[0]).toMatchObject({
      label: "ENG-12",
      url: "https://linear.app/acme/issue/ENG-12",
    });
  });

  test("links are deduplicated, kept in step order and capped", () => {
    const steps = Array.from({ length: RECORD_LINK_LIMIT + 5 }, (_, index) =>
      httpStep("POST", "https://api.github.com/repos/acme/app/issues", {
        number: index % (RECORD_LINK_LIMIT + 2),
      }),
    );
    const out = links("github", steps);
    expect(out).toHaveLength(RECORD_LINK_LIMIT);
    expect(out[0]?.url).toBe("https://github.com/acme/app/issues/0");
    expect(new Set(out.map((link) => link.url)).size).toBe(RECORD_LINK_LIMIT);
  });

  test("an unknown connector or one without a built-in template yields nothing", () => {
    const step = httpStep("POST", "https://api.github.com/repos/acme/app/issues", issue);
    expect(deriveRecordLinks([step], () => null)).toEqual([]);
  });
});

describe("record links honour privacy", () => {
  const url = "https://api.github.com/repos/acme/app/issues";

  test.each([
    ["a failed step", { status: "failed" }],
    ["a held write", { held: true }],
    ["an offloaded result", { result_storage_uri: "s3://bucket/key", output_preview: null }],
    ["redacted fields", { redacted_fields: [{ path: "$.title", action: "mask" }] }],
    [
      "a sensitive output",
      { output_preview: { $sensitive: true, ciphertext: "a", iv: "b", auth_tag: "c" } },
    ],
    ["a non-request step", { kind: "transform" }],
  ])("%s yields no link", (_name, overrides) => {
    expect(
      links("github", [httpStep("POST", url, issue, overrides as Partial<RecordLinkStep>)]),
    ).toEqual([]);
  });

  test("a redaction marker anywhere in the output yields no link", () => {
    expect(
      links("github", [httpStep("POST", url, { ...issue, token: "***REDACTED:secret_output***" })]),
    ).toEqual([]);
  });

  test("a warnings wrapper is unwrapped before matching", () => {
    expect(
      links("github", [httpStep("POST", url, { value: issue, warnings: [{ code: "w" }] })])[0]?.url,
    ).toBe("https://github.com/acme/app/issues/42");
  });
});

describe("record links accept only https on the known web host", () => {
  const url = "https://api.github.com/repos/acme/app/issues";

  test.each([
    "http://github.com/acme/app/issues/42",
    "https://github.com.evil.example/acme/app/issues/42",
    "https://github.com@evil.example/acme/app/issues/42",
    "https://user:pw@github.com/acme/app/issues/42",
    "https://github.com:8443/acme/app/issues/42",
    "javascript:alert(1)",
    "https://evil.example/acme",
  ])("a response URL %s falls back to the template", (html_url) => {
    const [link] = links("github", [httpStep("POST", url, { number: 42, html_url })]);
    expect(link?.url).toBe("https://github.com/acme/app/issues/42");
  });

  test("a value that would change the path is refused", () => {
    expect(links("github", [httpStep("POST", url, { number: "../../evil" })])).toEqual([]);
    expect(links("github", [httpStep("POST", url, { number: "1/../x" })])).toEqual([]);
  });

  test("a request to a different host than the template yields no link", () => {
    expect(
      links("github", [
        httpStep("POST", "https://github.example.com/api/v3/repos/acme/app/issues", issue),
      ]),
    ).toEqual([]);
  });
});
