// Locks the draft-time auth shortcut: when an operator pastes a token
// into `ask_user_form` for a NOT-yet-saved connector, the form value
// lands in `connector.config.{token,auth_value,…}`. Without this
// shortcut, `probe_connector_draft` would always see HTTP 401 because
// applyAuthMaterial exits early when no `connector_credentials` row
// exists yet — exactly the bug observed in session 84d06d81 where the
// LLM had to invent workarounds (manual `Authorization` headers on
// probe) before it could verify the endpoint.

import { describe, expect, test } from "bun:test";
import { applyAuthMaterial } from "../drivers/http.ts";
import type { ConnectorView } from "../types.ts";

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
    template_slug: null,
    template_name: null,
    template_source: null,
    template_version: null,
    template_snapshot: null,
    created_at: new Date(),
    updated_at: new Date(),
    circuit_state: "closed",
    circuit_opened_at: null,
    circuit_failure_count: 0,
    circuit_threshold: 5,
    circuit_reset_ms: 300000,
    ...over,
  } as ConnectorView;
}

describe("applyAuthMaterial — draft-time auth shortcut (no credential row yet)", () => {
  test("auth_type=bearer + config.token sets Authorization: Bearer ...", () => {
    const headers: Record<string, string> = {};
    applyAuthMaterial(
      connector({ auth_type: "bearer", config: { token: "ghp_paste" } }),
      null,
      headers,
      {},
    );
    expect(headers.Authorization).toBe("Bearer ghp_paste");
  });

  test("auth_type=bearer also accepts config.access_token (oauth-shaped form)", () => {
    const headers: Record<string, string> = {};
    applyAuthMaterial(
      connector({ auth_type: "bearer", config: { access_token: "ya29.AB" } }),
      null,
      headers,
      {},
    );
    expect(headers.Authorization).toBe("Bearer ya29.AB");
  });

  test("auth_type=bearer falls back to config.auth_value (LLM workaround shape)", () => {
    const headers: Record<string, string> = {};
    applyAuthMaterial(
      connector({ auth_type: "bearer", config: { auth_value: "ghp_alt" } }),
      null,
      headers,
      {},
    );
    expect(headers.Authorization).toBe("Bearer ghp_alt");
  });

  test("auth_type=header + auth_header/auth_value sets the named header", () => {
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
    expect(headers["X-Api-Key"]).toBe("k_123");
  });

  test("auth_type=header + config.headers spreads verbatim", () => {
    const headers: Record<string, string> = {};
    applyAuthMaterial(
      connector({
        auth_type: "header",
        config: {
          headers: { Authorization: "token ghp_xyz", "X-GitHub-Api-Version": "2022-11-28" },
        },
      }),
      null,
      headers,
      {},
    );
    expect(headers.Authorization).toBe("token ghp_xyz");
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
  });

  test("auth_type=basic + username/password sets Authorization: Basic <b64>", () => {
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
    const expected = `Basic ${Buffer.from("alice:s3cret", "utf8").toString("base64")}`;
    expect(headers.Authorization).toBe(expected);
  });

  test("missing token leaves Authorization unset (no fabricated header)", () => {
    const headers: Record<string, string> = {};
    applyAuthMaterial(connector({ auth_type: "bearer", config: {} }), null, headers, {});
    expect(headers.Authorization).toBeUndefined();
  });

  test("auth_type=none never injects auth even if config.token is present", () => {
    const headers: Record<string, string> = {};
    applyAuthMaterial(
      connector({ auth_type: "none", config: { token: "should-not-leak" } }),
      null,
      headers,
      {},
    );
    expect(headers.Authorization).toBeUndefined();
  });
});
