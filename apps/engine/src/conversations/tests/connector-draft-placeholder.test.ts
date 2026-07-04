// Refuses placeholder hostnames the model would otherwise fabricate.
// Without this gate, a careless first turn produces base_urls like
// `https://api.example.com` or `https://your-host.com`, the draft
// passes basic URL parsing, the next probe fails opaquely with DNS
// errors, and the user gets a confusing turn instead of a clear
// "ground this from real context" instruction.

import { describe, expect, test } from "bun:test";
import { validateConnectorDraft } from "../connector-draft.ts";
import type { ConnectorDraftDocument } from "../types.ts";

function draft(over: Partial<ConnectorDraftDocument> = {}): ConnectorDraftDocument {
  return {
    name: "demo",
    slug: "demo",
    driver: "http",
    environment: "dev",
    auth_type: "none",
    base_url: "https://api.demo.tld",
    ...over,
  } as ConnectorDraftDocument;
}

describe("validateConnectorDraft — placeholder host gate", () => {
  test("accepts a real-looking hostname", () => {
    const result = validateConnectorDraft(draft({ base_url: "https://api.github.com" }), []);
    expect(result.ok).toBe(true);
  });

  test("rejects example.com family", () => {
    for (const url of [
      "https://api.example.com/v1",
      "https://example.org",
      "https://test.example.net",
    ]) {
      const result = validateConnectorDraft(draft({ base_url: url }), []);
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.path === "base_url")).toBe(true);
      expect(result.errors[0]!.message).toMatch(/placeholder/);
    }
  });

  test("does NOT reject loopback / localhost (legitimate dev fixtures)", () => {
    // Models rarely fabricate loopback URLs as fake production targets,
    // and real dev/test setups point at local stubs. The placeholder
    // gate would be a false-positive nightmare for the tool-test
    // harness if it flagged 127.0.0.1.
    for (const url of ["http://localhost:3000", "http://127.0.0.1:8080", "http://0.0.0.0:9000"]) {
      const result = validateConnectorDraft(draft({ base_url: url }), []);
      expect(result.ok).toBe(true);
    }
  });

  test("rejects 'your-host' style fabrications via the placeholder gate", () => {
    for (const url of ["https://your-host.com", "https://api.your-company.com"]) {
      const result = validateConnectorDraft(draft({ base_url: url }), []);
      expect(result.ok).toBe(false);
      expect(result.errors[0]!.message).toMatch(/placeholder/);
    }
  });

  test("rejects '<YOUR_HOST>' / '[YOUR_API]' bracket fabrications via the URL-validity gate", () => {
    // These never parse as URLs, so the validity check fires first; the
    // important property is that they are refused with SOME blocking
    // error, not silently accepted.
    for (const url of ["https://<YOUR_HOST>", "https://[YOUR_API].com"]) {
      const result = validateConnectorDraft(draft({ base_url: url }), []);
      expect(result.ok).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  test("does not double-flag legitimate template placeholders like {{tenant}}", () => {
    // `${field}` placeholders are already caught earlier as missing_fields,
    // not as placeholder URLs. Confirm we don't accidentally mark them as
    // placeholder errors too.
    const result = validateConnectorDraft(
      draft({ base_url: "https://$" + "{region}.api.real.com" }),
      [],
    );
    expect(result.errors.some((e) => e.message.includes("placeholder"))).toBe(false);
  });
});

describe("validateConnectorDraft — GraphQL endpoint url_pattern gate", () => {
  // For the GraphQL driver `base_url` IS the full endpoint URL. A base_url
  // trimmed to the host root (dropping `/graphql`) parses fine but 404s
  // every request — AppSync answers `UnknownOperationException`. The
  // template's `url_pattern` is the canonical endpoint shape, so the
  // draft must be refused at save time rather than at run time.
  const FULL_APPSYNC_URL = "https://abc123def456.appsync-api.eu-central-1.amazonaws.com/graphql";
  const HOST_ROOT_APPSYNC_URL = "https://abc123def456.appsync-api.eu-central-1.amazonaws.com";

  test("rejects a graphql base_url trimmed to the host root", () => {
    const result = validateConnectorDraft(
      draft({
        driver: "graphql",
        auth_type: "oauth2",
        template_slug: "appsync-cognito",
        base_url: HOST_ROOT_APPSYNC_URL,
      }),
      [],
    );
    expect(result.ok).toBe(false);
    const err = result.errors.find((e) => e.path === "base_url");
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/full GraphQL endpoint URL/);
  });

  test("accepts a graphql base_url that is the full /graphql endpoint", () => {
    const result = validateConnectorDraft(
      draft({
        driver: "graphql",
        auth_type: "oauth2",
        template_slug: "appsync-cognito",
        base_url: FULL_APPSYNC_URL,
      }),
      [],
    );
    expect(result.ok).toBe(true);
  });

  test("does NOT enforce url_pattern on HTTP connectors (host-root base_url is valid)", () => {
    // HTTP connectors legitimately store a host-root base_url and address
    // many paths per step, so the url_pattern gate is GraphQL-only. A
    // Stripe HTTP connector pointed at the host root must still validate.
    const result = validateConnectorDraft(
      draft({
        driver: "http",
        auth_type: "bearer",
        template_slug: "stripe",
        base_url: "https://api.stripe.com",
      }),
      [],
    );
    expect(result.ok).toBe(true);
  });
});
