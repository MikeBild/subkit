import { describe, expect, test } from "bun:test";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { applyAuthMaterial } from "../drivers/http.ts";
import type { ConnectorView } from "../types.ts";

const TEST_NOW_MS = getTestNow();

function connector(over: Partial<ConnectorView>): ConnectorView {
  return {
    id: "draft-c",
    tenant_id: "t",
    slug: "draft-c",
    display_name: "Draft connector",
    driver: "http",
    environment: "dev",
    auth_type: "none",
    base_url: "https://api.example.tld",
    dsn: null,
    config: {},
    operator_notes: null,
    template_slug: null,
    template_name: null,
    template_source: null,
    template_version: null,
    template_snapshot: null,
    created_at: new Date(TEST_NOW_MS),
    updated_at: new Date(TEST_NOW_MS),
    circuit_state: "closed",
    circuit_opened_at: null,
    circuit_failure_count: 0,
    circuit_threshold: 5,
    circuit_reset_ms: 300000,
    ...over,
  } as ConnectorView;
}

describe("applyAuthMaterial — no credential row (credential_required contract)", () => {
  test("auth_type=bearer + null credential does NOT inject Authorization header", () => {
    const headers: Record<string, string> = {};
    applyAuthMaterial(
      connector({ auth_type: "bearer", config: { token: "ghp_should_not_apply" } }),
      null,
      headers,
      {},
    );
    expect(headers.Authorization).toBeUndefined();
  });

  test("auth_type=header + null credential does NOT inject custom header", () => {
    const headers: Record<string, string> = {};
    applyAuthMaterial(
      connector({
        auth_type: "header",
        config: { auth_header: "X-Api-Key", auth_value: "k_123" },
      }),
      null,
      headers,
      {},
    );
    expect(headers["X-Api-Key"]).toBeUndefined();
  });

  test("auth_type=basic + null credential does NOT inject Authorization header", () => {
    const headers: Record<string, string> = {};
    applyAuthMaterial(
      connector({
        auth_type: "basic",
        config: { username: "alice", password: "s3cret" },
      }),
      null,
      headers,
      {},
    );
    expect(headers.Authorization).toBeUndefined();
  });

  test("auth_type=none + null credential does NOT inject auth", () => {
    const headers: Record<string, string> = {};
    applyAuthMaterial(
      connector({ auth_type: "none", config: { token: "should-not-leak" } }),
      null,
      headers,
      {},
    );
    expect(headers.Authorization).toBeUndefined();
  });

  test("static_headers from config still apply even with null credential", () => {
    const headers: Record<string, string> = {};
    applyAuthMaterial(
      connector({
        auth_type: "bearer",
        config: { static_headers: { "x-static": "v1" } },
      }),
      null,
      headers,
      {},
    );
    expect(headers["x-static"]).toBe("v1");
    expect(headers.Authorization).toBeUndefined();
  });

  test("static_query from config still applies even with null credential", () => {
    const headers: Record<string, string> = {};
    const query: Record<string, string | number | boolean> = {};
    applyAuthMaterial(
      connector({
        auth_type: "header",
        config: { static_query: { format: "json" } },
      }),
      null,
      headers,
      query,
    );
    expect(query.format).toBe("json");
    expect(headers["X-Api-Key"]).toBeUndefined();
  });
});
