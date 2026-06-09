// Connector-response health classification. Pinned so a transport-level
// success that is actually an auth failure / removed endpoint / vendor 5xx
// is never reported to the LLM as a healthy empty result.

import { describe, expect, test } from "bun:test";
import { type ConnectorHealth, classifyConnectorHealth, connectorHealthHint } from "./health.ts";

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
    // Inspectable 4xx the caller may legitimately handle — stays ok.
    { status: 404, expect: "ok" },
    { status: 409, expect: "ok" },
    { status: 422, expect: "ok" },
    { status: 429, expect: "ok" },
    // Auth failures.
    { status: 401, expect: "auth_failed" },
    { status: 403, expect: "auth_failed" },
    // Removed endpoint.
    { status: 410, expect: "endpoint_gone" },
    // Vendor-side failures.
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
});

describe("connectorHealthHint", () => {
  test("ok → null (nothing attached on the healthy path)", () => {
    expect(connectorHealthHint("ok", "si-emobility-jira")).toBeNull();
  });

  test("auth_failed names the connector and points at credential setup", () => {
    const hint = connectorHealthHint("auth_failed", "si-emobility-jira");
    expect(hint).not.toBeNull();
    expect(hint?.suggestion).toContain("si-emobility-jira");
    expect(hint?.next_best_actions).toContain("setup_connector_credentials");
  });

  test("endpoint_gone points at docs", () => {
    const hint = connectorHealthHint("endpoint_gone", "jira");
    expect(hint?.suggestion).toContain("410");
    expect(hint?.next_best_actions).toContain("fetch_connector_docs");
  });

  test("degraded explains a transient 5xx", () => {
    const hint = connectorHealthHint("degraded", "jira");
    expect(hint?.suggestion).toContain("5xx");
  });
});
