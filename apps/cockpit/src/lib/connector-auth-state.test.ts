import { describe, expect, test } from "bun:test";
import { connectorAuthState, connectorHealthLabel, needsRenewal } from "./connector-auth-state";
import { CATALOGS } from "./i18n";
import { statusLabel } from "./status-label";

describe("connector auth state", () => {
  test("a rejected credential reads as expired whichever column carries it", () => {
    expect(connectorAuthState({ auth_type: "bearer", needs_reauth: true })).toBe("expired");
    expect(connectorAuthState({ auth_type: "bearer", health_state: "needs_reauth" })).toBe(
      "expired",
    );
  });

  test("a connector without credentials says so instead of claiming a connection", () => {
    expect(connectorAuthState({ auth_type: "none", health_state: "ok" })).toBe("not_required");
  });

  test("healthy and never rejected reads as connected", () => {
    expect(connectorAuthState({ auth_type: "bearer", health_state: "ok" })).toBe("connected");
  });

  test("a past auth failure is not painted over by a healthy rollup", () => {
    expect(
      connectorAuthState({
        auth_type: "bearer",
        health_state: "ok",
        auth_failed_at: "2026-08-01T00:00:00.000Z",
      }),
    ).toBe("unproven");
  });

  test("a vendor outage is not reported as a credential problem", () => {
    expect(connectorAuthState({ auth_type: "bearer", health_state: "degraded" })).toBe("unproven");
    expect(connectorAuthState({ auth_type: "bearer", health_state: "needs_update" })).toBe(
      "unproven",
    );
  });

  test("an expired or unreadable Kontoverbindung is an expired sign-in before any request fails", () => {
    const connector = { auth_type: "oauth2", health_state: "ok" };
    for (const state of ["expired", "unreadable"] as const) {
      expect(
        connectorAuthState(connector, null, { mode: "connection", connection: { state } }),
      ).toBe("expired");
    }
    expect(
      connectorAuthState(connector, null, { mode: "connection", connection: { state: "valid" } }),
    ).toBe("connected");
  });

  test("a credential read that found nothing says credentials are missing, not unproven", () => {
    expect(connectorAuthState({ auth_type: "bearer", health_state: "degraded" }, null, null)).toBe(
      "credentials_missing",
    );
    expect(connectorAuthState({ auth_type: "bearer", health_state: "degraded" })).toBe("unproven");
    for (const auth_type of [
      "bearer",
      "header",
      "query",
      "basic",
      "oauth2",
      "signed_jwt",
      "aws_sigv4",
    ]) {
      expect(connectorAuthState({ auth_type, health_state: "ok" }, null, null)).toBe(
        "credentials_missing",
      );
    }
    expect(
      connectorAuthState(
        { auth_type: "basic", driver: "postgres", health_state: "ok" },
        null,
        null,
      ),
    ).toBe("connected");
    expect(
      connectorAuthState(
        { auth_type: "oauth2_client", driver: "mcp", health_state: "ok" },
        null,
        null,
      ),
    ).toBe("connected");
    expect(connectorAuthState({ auth_type: "none", health_state: "ok" }, null, null)).toBe(
      "not_required",
    );
  });

  test("a probe resolves what the list could not prove", () => {
    expect(
      connectorAuthState({ auth_type: "bearer", health_state: "degraded" }, { ok: true }),
    ).toBe("connected");
    expect(
      connectorAuthState(
        { auth_type: "bearer", health_state: "ok" },
        { ok: false, error_code: "credential_missing" },
      ),
    ).toBe("credentials_missing");
    expect(
      connectorAuthState(
        { auth_type: "bearer", health_state: "ok" },
        { ok: false, error_code: "credential_expired" },
      ),
    ).toBe("expired");
  });

  test("a failing probe for a non-credential reason leaves the stored verdict standing", () => {
    expect(
      connectorAuthState(
        { auth_type: "bearer", health_state: "ok" },
        { ok: false, error_code: "remote_api_disabled" },
      ),
    ).toBe("connected");
  });

  test("every connector health state has a word of its own, never 'unknown'", () => {
    for (const state of ["ok", "degraded", "needs_update", "needs_reauth", "needs_attention"]) {
      const key = connectorHealthLabel(state);
      expect(key).not.toBeNull();
      const en = CATALOGS.en[key as keyof typeof CATALOGS.en];
      const de = CATALOGS.de[key as keyof typeof CATALOGS.de];
      expect(en.toLowerCase()).not.toContain("unknown");
      expect(de.toLowerCase()).not.toContain("unbekannt");
    }
  });

  test("degraded has one truthful label across connector and workflow status surfaces", () => {
    expect(connectorHealthLabel("degraded")).toBe("connectors.healthState.degraded");
    expect(statusLabel((key) => key, "degraded")).toBe("connectors.healthState.degraded");
    expect(CATALOGS.en["connectors.healthState.degraded"]).toBe("Limited");
    expect(CATALOGS.de["connectors.healthState.degraded"]).toBe("Eingeschränkt");
  });

  test("an unmapped health state yields no line rather than an invented one", () => {
    expect(connectorHealthLabel("something_new")).toBeNull();
  });

  test("only credential faults offer a renewal path", () => {
    expect(needsRenewal("expired")).toBe(true);
    expect(needsRenewal("credentials_missing")).toBe(true);
    expect(needsRenewal("connected")).toBe(false);
    expect(needsRenewal("unproven")).toBe(false);
  });
});
