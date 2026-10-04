import { describe, expect, test } from "bun:test";
import {
  type ConnectorHealth,
  classifyConnectorHealth,
  connectorHealthHint,
  isConnectorUnusable,
  parseDeprecation,
} from "./health.ts";

describe("classifyConnectorHealth", () => {
  const cases: Array<{
    status: number;
    headers?: Record<string, string>;
    expect: ConnectorHealth;
  }> = [
    { status: 200, expect: "ok" },
    { status: 201, expect: "ok" },
    { status: 204, expect: "ok" },
    { status: 301, expect: "ok" },
    { status: 409, expect: "ok" },
    { status: 422, expect: "ok" },
    { status: 404, expect: "not_found" },
    { status: 429, expect: "rate_limited" },
    { status: 401, expect: "auth_failed" },
    { status: 403, expect: "auth_failed" },
    { status: 410, expect: "endpoint_gone" },
    { status: 500, expect: "degraded" },
    { status: 503, expect: "degraded" },
  ];

  for (const c of cases) {
    test(`status ${c.status} → ${c.expect}`, () => {
      expect(classifyConnectorHealth(c.status, c.headers)).toBe(c.expect);
    });
  }

  test("Atlassian Seraph anonymous-200 is auth_failed despite HTTP 200", () => {
    expect(classifyConnectorHealth(200, { "x-seraph-loginreason": "AUTHENTICATED_FAILED" })).toBe(
      "auth_failed",
    );
  });

  test("Seraph header with OK reason on a 200 stays ok", () => {
    expect(classifyConnectorHealth(200, { "x-seraph-loginreason": "OK" })).toBe("ok");
  });

  test("Seraph match is case-insensitive and substring-tolerant", () => {
    expect(
      classifyConnectorHealth(200, { "x-seraph-loginreason": "authenticated_failed,ok" }),
    ).toBe("auth_failed");
  });

  test("missing headers → classifies on status alone", () => {
    expect(classifyConnectorHealth(200, undefined)).toBe("ok");
    expect(classifyConnectorHealth(401, undefined)).toBe("auth_failed");
  });

  test("2xx carrying a Deprecation header → deprecated (early warning, not failure)", () => {
    expect(classifyConnectorHealth(200, { deprecation: "true" })).toBe("deprecated");
    expect(classifyConnectorHealth(200, { sunset: "Sat, 31 Jan 2026 23:59:59 GMT" })).toBe(
      "deprecated",
    );
  });

  test("Seraph auth failure is NOT shadowed by a deprecation header", () => {
    expect(
      classifyConnectorHealth(200, {
        "x-seraph-loginreason": "AUTHENTICATED_FAILED",
        deprecation: "true",
      }),
    ).toBe("auth_failed");
  });

  test("a failing status with deprecation headers keeps the failure verdict", () => {
    expect(classifyConnectorHealth(410, { deprecation: "true" })).toBe("endpoint_gone");
  });
});

describe("isConnectorUnusable", () => {
  test("only connector-level faults are unusable", () => {
    expect(isConnectorUnusable("auth_failed")).toBe(true);
    expect(isConnectorUnusable("endpoint_gone")).toBe(true);
    expect(isConnectorUnusable("ok")).toBe(false);
    expect(isConnectorUnusable("deprecated")).toBe(false);
    expect(isConnectorUnusable("not_found")).toBe(false);
    expect(isConnectorUnusable("rate_limited")).toBe(false);
    expect(isConnectorUnusable("degraded")).toBe(false);
  });
});

describe("parseDeprecation", () => {
  test("no deprecation headers → null", () => {
    expect(parseDeprecation(undefined)).toBeNull();
    expect(parseDeprecation({})).toBeNull();
    expect(parseDeprecation({ "content-type": "application/json" })).toBeNull();
  });

  test("Deprecation: true without a date", () => {
    const sig = parseDeprecation({ deprecation: "true" });
    expect(sig).toEqual({ deprecated: "true", sunset: null, successor_uri: null });
  });

  test("Sunset alone is a deprecation signal", () => {
    const sig = parseDeprecation({ sunset: "Sat, 31 Jan 2026 23:59:59 GMT" });
    expect(sig?.sunset).toBe("Sat, 31 Jan 2026 23:59:59 GMT");
  });

  test("a successor-version Link ALONE is a signal (vendors attach only it to the final 410)", () => {
    const sig = parseDeprecation({
      link: '<https://api.example/v3/search/jql>; rel="successor-version"',
    });
    expect(sig?.successor_uri).toBe("https://api.example/v3/search/jql");
    expect(sig?.deprecated).toBe("true");
  });

  test("Link rel=deprecation carries the docs URI", () => {
    const sig = parseDeprecation({
      deprecation: "true",
      link: '<https://developer.atlassian.com/changelog/123>; rel="deprecation"',
    });
    expect(sig?.successor_uri).toBe("https://developer.atlassian.com/changelog/123");
  });

  test("rel=successor-version wins over rel=deprecation across multiple links", () => {
    const sig = parseDeprecation({
      deprecation: "true",
      link: '<https://docs.example/changelog>; rel="deprecation", <https://api.example/v3/search/jql>; rel="successor-version"',
    });
    expect(sig?.successor_uri).toBe("https://api.example/v3/search/jql");
  });
});

describe("connectorHealthHint", () => {
  test("ok → null (nothing attached on the healthy path)", () => {
    expect(connectorHealthHint("ok", "acme-jira")).toBeNull();
  });

  test("auth_failed names the connector and points at credential setup", () => {
    const hint = connectorHealthHint("auth_failed", "acme-jira");
    expect(hint).not.toBeNull();
    expect(hint?.error_code).toBe("auth_rejected");
    expect(hint?.suggestion).toContain("acme-jira");
    expect(hint?.next_best_actions).toContain("setup_connector_credentials");
  });

  test("endpoint_gone points at docs", () => {
    const hint = connectorHealthHint("endpoint_gone", "jira");
    expect(hint?.error_code).toBe("endpoint_removed");
    expect(hint?.suggestion).toContain("410");
    expect(hint?.next_best_actions).toContain("fetch_connector_docs");
  });

  test("endpoint_gone surfaces the announced replacement when known", () => {
    const hint = connectorHealthHint("endpoint_gone", "jira", {
      deprecation: {
        deprecated: "true",
        sunset: null,
        successor_uri: "https://api.example/rest/api/3/search/jql",
      },
    });
    expect(hint?.suggestion).toContain("https://api.example/rest/api/3/search/jql");
  });

  test("deprecated carries the sunset date and says the call still succeeded", () => {
    const hint = connectorHealthHint("deprecated", "jira", {
      deprecation: {
        deprecated: "true",
        sunset: "Sat, 31 Jan 2026 23:59:59 GMT",
        successor_uri: null,
      },
    });
    expect(hint?.error_code).toBe("endpoint_deprecated");
    expect(hint?.suggestion).toContain("Sat, 31 Jan 2026 23:59:59 GMT");
    expect(hint?.suggestion).toContain("still succeeded");
  });

  test("not_found on /orgs/{x} suggests the /users/{x} fallback", () => {
    const hint = connectorHealthHint("not_found", "github", { path: "/orgs/octocat/repos" });
    expect(hint?.error_code).toBe("resource_not_found");
    expect(hint?.suggestion).toContain("/users/octocat/repos");
    expect(hint?.suggestion).toContain("user account");
  });

  test("not_found without an /orgs path stays generic and non-alarming", () => {
    const hint = connectorHealthHint("not_found", "jira", { path: "/rest/api/3/issue/NOPE-1" });
    expect(hint?.error_code).toBe("resource_not_found");
    expect(hint?.suggestion).toContain("not a broken connector");
  });

  test("rate_limited surfaces the Retry-After when known", () => {
    const hint = connectorHealthHint("rate_limited", "github", { retry_after_s: 30 });
    expect(hint?.error_code).toBe("rate_limited");
    expect(hint?.suggestion).toContain("30s");
  });

  test("degraded explains a transient 5xx", () => {
    const hint = connectorHealthHint("degraded", "jira");
    expect(hint?.error_code).toBe("vendor_degraded");
    expect(hint?.suggestion).toContain("5xx");
  });
});
