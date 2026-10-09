import { describe, expect, test } from "bun:test";
import {
  CONNECTOR_STRIP_KEYS,
  type ConnectorStripInput,
  connectorExpiry,
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
    signInFailed: false,
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

  test("a failed sign-in leads the strip, with one way to sign in again", () => {
    expect(connectorStrip(input({ signInFailed: true, auth: "expired" }))).toEqual({
      kind: "signInFailed",
      tone: "error",
      action: { kind: "retry", way: "provider" },
      lower: ["expired"],
    });
    expect(connectorStripActionKey({ kind: "retry", way: "provider" })).toBe(
      "connectorStrip.action.signInAgain",
    );
    expect(CATALOGS.de["connectorStrip.state.signInFailed"]).toBe("Anmeldung fehlgeschlagen");
    expect(CATALOGS.de["connectorStrip.action.signInAgain"]).toBe("Erneut anmelden");
    expect(CATALOGS.en["connectorStrip.state.signInFailed"]).toBe("Sign-in failed");
  });

  test("a failed sign-in offers no retry to a reader who may not sign in", () => {
    expect(connectorStrip(input({ signInFailed: true, way: null })).action).toBeNull();
  });

  test("a confirmed sign-in is the calm strip, and never alongside a failure", () => {
    expect(connectorStrip(input({ returned: true }))).toEqual({
      kind: "signedIn",
      tone: "ok",
      action: null,
      lower: [],
    });
    expect(connectorStrip(input({ returned: true, signInFailed: true })).kind).toBe("signInFailed");
  });
});

describe("connector expiry evidence", () => {
  test("reads only the configured environment and rejects missing or malformed expiry", () => {
    const expiry = "2030-01-01T00:00:00.000Z";
    const rows = [{ environment: "dev", oauth2_expires_at: expiry }];
    expect(connectorExpiry(rows, "dev")).toBe(expiry);
    expect(connectorExpiry(rows, "prod")).toBeNull();
    expect(
      connectorExpiry([{ environment: "prod", oauth2_expires_at: "not a date" }], "prod"),
    ).toBeNull();
    expect(connectorExpiry(undefined, "prod")).toBeNull();
  });
});
