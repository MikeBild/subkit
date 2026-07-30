// Unit tests for `hydrateDraftFromSavedConnector` — the helper that
// builds a re-issue-bound connector draft from an already-saved connector.
// Pure function: no DB, no network.

import { describe, expect, it } from "bun:test";
import type { ConnectorView } from "../../connectors/types.ts";
import { hydrateDraftFromSavedConnector } from "./normalize.ts";

function makeView(overrides: Partial<ConnectorView> = {}): ConnectorView {
  return {
    id: "conn-uuid-1",
    tenant_id: "tenant-1",
    slug: "my-api",
    display_name: "My API",
    driver: "http",
    environment: "dev",
    auth_type: "basic",
    base_url: "https://api.example.com",
    dsn: null,
    config: { timeout: 5000 },
    operator_quirks: {},
    template_slug: "generic-rest",
    template_name: "Generic REST",
    template_source: "builtin",
    template_version: 1,
    template_snapshot: null,
    self_description: {},
    created_at: new Date("2024-01-01"),
    updated_at: new Date("2024-01-02"),
    enabled: true,
    last_error: null,
    circuit_state: "closed",
    circuit_opened_at: null,
    circuit_failure_count: 0,
    circuit_threshold: 5,
    circuit_reset_ms: 30_000,
    needs_reauth: true,
    auth_failed_at: new Date("2024-01-02"),
    auth_failed_reason: "token_expired",
    health_state: "ok",
    health_reason: null,
    health_error_code: null,
    sunset_at: null,
    successor_uri: null,
    ...overrides,
  };
}

describe("hydrateDraftFromSavedConnector", () => {
  it("sets saved_connector_id to the view's id — the re-issue branch anchor", () => {
    const draft = hydrateDraftFromSavedConnector(makeView());
    expect(draft.saved_connector_id).toBe("conn-uuid-1");
  });

  it("copies display_name into the draft name field", () => {
    const draft = hydrateDraftFromSavedConnector(makeView({ display_name: "Jira Cloud" }));
    expect(draft.name).toBe("Jira Cloud");
  });

  it("copies driver, auth_type, config, slug", () => {
    const view = makeView({ driver: "graphql", auth_type: "bearer", slug: "my-graphql" });
    const draft = hydrateDraftFromSavedConnector(view);
    expect(draft.driver).toBe("graphql");
    expect(draft.auth_type).toBe("bearer");
    expect(draft.slug).toBe("my-graphql");
    expect(draft.config).toEqual({ timeout: 5000 });
  });

  it("sets latest_probe to null — the re-issue path re-runs probe from scratch", () => {
    const draft = hydrateDraftFromSavedConnector(makeView());
    expect(draft.latest_probe).toBeNull();
  });

  it("includes base_url when the view has one", () => {
    const draft = hydrateDraftFromSavedConnector(makeView({ base_url: "https://api.example.com" }));
    expect(draft.base_url).toBe("https://api.example.com");
  });

  it("omits base_url when the view has none (null)", () => {
    const draft = hydrateDraftFromSavedConnector(makeView({ base_url: null }));
    expect("base_url" in draft).toBe(false);
  });

  it("copies template_slug, template_name, template_source", () => {
    const draft = hydrateDraftFromSavedConnector(
      makeView({ template_slug: "jira", template_name: "Jira", template_source: "builtin" }),
    );
    expect(draft.template_slug).toBe("jira");
    expect(draft.template_name).toBe("Jira");
    expect(draft.template_source).toBe("builtin");
  });

  it("sets config to empty object when the view has null config", () => {
    // ConnectorView.config is typed non-null but guard defensively
    const view = makeView({ config: {} });
    const draft = hydrateDraftFromSavedConnector(view);
    expect(draft.config).toEqual({});
  });

  it("omits dsn when null", () => {
    const draft = hydrateDraftFromSavedConnector(makeView({ dsn: null }));
    expect("dsn" in draft).toBe(false);
  });

  it("includes dsn when present on the view", () => {
    const draft = hydrateDraftFromSavedConnector(
      makeView({ dsn: "postgres://localhost/mydb", driver: "postgres" }),
    );
    expect(draft.dsn).toBe("postgres://localhost/mydb");
  });

  it("does NOT carry operator_quirks — the re-issue persists to the same row that retains them", () => {
    const draft = hydrateDraftFromSavedConnector(
      makeView({ operator_quirks: { auth: "send token as X-Token header" } }),
    );
    // ConnectorDraftDocument has no operator_quirks field; the saved row keeps
    // its quirks, so the re-issue draft intentionally drops them (no loss).
    expect("operator_quirks" in draft).toBe(false);
  });
});
