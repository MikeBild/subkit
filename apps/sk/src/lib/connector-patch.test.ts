import { describe, expect, test } from "bun:test";
import {
  connectorDisplayName,
  connectorPatchBody,
  connectorPatchDraft,
  mergeConnectorConfig,
} from "./connector-patch.ts";

const current = {
  id: "c1",
  slug: "google-search-console",
  display_name: "Google Search Console",
  driver: "http",
  environment: "prod",
  auth_type: "oauth2",
  base_url: "https://searchconsole.googleapis.com",
  dsn: null,
  config: {
    oauth: {
      scope: "https://www.googleapis.com/auth/webmasters.readonly",
      token_endpoint: "https://oauth2.googleapis.com/token",
    },
    capabilities: { webhooks: false, webhook_events: [] },
  },
};

describe("mergeConnectorConfig", () => {
  test("keeps sibling keys when a nested key changes", () => {
    expect(
      mergeConnectorConfig(current.config, {
        oauth: { scope: "https://www.googleapis.com/auth/webmasters" },
      }),
    ).toEqual({
      oauth: {
        scope: "https://www.googleapis.com/auth/webmasters",
        token_endpoint: "https://oauth2.googleapis.com/token",
      },
      capabilities: { webhooks: false, webhook_events: [] },
    });
  });

  test("replaces arrays and scalars", () => {
    expect(mergeConnectorConfig({ a: [1, 2], b: 1 }, { a: [3], b: null })).toEqual({
      a: [3],
      b: null,
    });
  });
});

describe("connectorPatchBody", () => {
  test("sends the merged config", () => {
    const body = connectorPatchBody(current, { config: { oauth: { scope: "x" } } });
    expect((body.config as { oauth: Record<string, unknown> }).oauth).toEqual({
      scope: "x",
      token_endpoint: "https://oauth2.googleapis.com/token",
    });
  });

  test("leaves a file without config untouched", () => {
    expect(connectorPatchBody(current, { name: "New" })).toEqual({ name: "New" });
  });

  test("sends the file config as is when the stored config is not an object", () => {
    expect(
      connectorPatchBody(
        { config: null as unknown as Record<string, unknown> },
        { config: { a: 1 } },
      ),
    ).toEqual({ config: { a: 1 } });
  });
});

describe("connectorPatchDraft", () => {
  test("builds a complete definition from the current connector and the patch", () => {
    const patch = connectorPatchBody(current, { config: { oauth: { scope: "x" } } });
    expect(connectorPatchDraft(current, patch)).toEqual({
      name: "Google Search Console",
      driver: "http",
      environment: "prod",
      auth_type: "oauth2",
      base_url: "https://searchconsole.googleapis.com",
      config: {
        oauth: { scope: "x", token_endpoint: "https://oauth2.googleapis.com/token" },
        capabilities: { webhooks: false, webhook_events: [] },
      },
    });
  });

  test("falls back to the slug, drops null fields and keeps a patched dsn", () => {
    const draft = connectorPatchDraft(
      { ...current, display_name: "", base_url: null, config: {} },
      { dsn: "postgres://db" },
    );
    expect(draft).toEqual({
      name: "google-search-console",
      driver: "http",
      environment: "prod",
      auth_type: "oauth2",
      config: {},
      dsn: "postgres://db",
    });
  });

  test("a patched auth type wins over the stored one", () => {
    expect(connectorPatchDraft(current, { auth_type: "bearer" }).auth_type).toBe("bearer");
  });

  test("refuses a stored driver, environment or auth type the engine does not accept", () => {
    expect(() => connectorPatchDraft({ ...current, driver: "ftp" }, {})).toThrow(
      "connector driver 'ftp' is not one the engine accepts",
    );
    expect(() => connectorPatchDraft({ ...current, environment: "staging" }, {})).toThrow(
      "connector environment 'staging' is not one the engine accepts",
    );
    expect(() => connectorPatchDraft({ ...current, auth_type: "magic" }, {})).toThrow(
      "connector auth_type 'magic' is not one the engine accepts",
    );
  });

  test("prefers a patched name and base_url", () => {
    const draft = connectorPatchDraft(current, { name: "Renamed", base_url: "https://x.test" });
    expect(draft.name).toBe("Renamed");
    expect(draft.base_url).toBe("https://x.test");
  });
});

describe("record helpers", () => {
  test("names the connector by display name, then slug, then id", () => {
    expect(connectorDisplayName(current)).toBe("Google Search Console");
    expect(connectorDisplayName({ id: "c9", slug: "s", display_name: "" })).toBe("s");
    expect(connectorDisplayName({ id: "c9", slug: "", display_name: "" })).toBe("c9");
  });
});
