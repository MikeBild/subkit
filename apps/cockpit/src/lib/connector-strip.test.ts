import { describe, expect, test } from "bun:test";
import {
  CONNECTOR_STRIP_KEYS,
  type ConnectorStripInput,
  connectorStrip,
  connectorStripActionKey,
} from "@/lib/connector-strip";
import { CATALOGS } from "@/lib/i18n";

function input(overrides: Partial<ConnectorStripInput>): ConnectorStripInput {
  return {
    auth: "connected",
    way: "provider",
    enabled: true,
    health: "ok",
    probe: null,
    missingScopes: 0,
    returned: false,
    rights: { write: true, test: true },
    ...overrides,
  };
}

describe("connector status strip (D15)", () => {
  test("a working connector is calm and offers nothing", () => {
    expect(connectorStrip(input({}))).toEqual({
      kind: "connected",
      tone: "ok",
      action: null,
      lower: [],
    });
  });

  test("an expired sign-in leads, renewed the way the connector signs in", () => {
    const strip = connectorStrip(
      input({ auth: "expired", enabled: false, way: "connection", missingScopes: 2 }),
    );
    expect(strip.kind).toBe("expired");
    expect(strip.action).toEqual({ kind: "renew", way: "connection" });
    expect(strip.lower).toEqual(["off", "incomplete"]);
  });

  test("switched off is switched on, and only with the right", () => {
    expect(connectorStrip(input({ enabled: false })).action).toEqual({ kind: "enable" });
    expect(
      connectorStrip(input({ enabled: false, rights: { write: false, test: true } })).action,
    ).toBeNull();
  });

  test("a failed test reads as unreachable, with one way to test again", () => {
    expect(connectorStrip(input({ probe: { ok: false } }))).toMatchObject({
      kind: "unreachable",
      tone: "error",
      action: { kind: "recheck" },
    });
    expect(connectorStrip(input({ probe: { ok: true } })).kind).toBe("tested");
  });

  test("missing credentials read as not signed in; withheld permissions are completed", () => {
    expect(connectorStrip(input({ auth: "credentials_missing", way: "key" }))).toMatchObject({
      kind: "notSignedIn",
      tone: "warn",
      action: { kind: "complete", way: "key", first: true },
    });
    expect(connectorStrip(input({ missingScopes: 1 })).kind).toBe("incomplete");
  });

  test("the return from the provider is said once the sign-in holds", () => {
    expect(connectorStrip(input({ returned: true })).kind).toBe("signedIn");
  });

  test("every state and action has words in both languages", () => {
    const keys = [
      ...Object.values(CONNECTOR_STRIP_KEYS),
      connectorStripActionKey({ kind: "recheck" }),
      connectorStripActionKey({ kind: "complete", way: "key", first: true }),
    ];
    for (const key of keys) {
      expect(CATALOGS.en[key]).toBeTruthy();
      expect(CATALOGS.de[key]).toBeTruthy();
    }
    expect(CATALOGS.de[connectorStripActionKey({ kind: "renew", way: "provider" })]).toBe(
      "Neu anmelden",
    );
  });
});
