import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { absolute, connectorHref } from "@/app/links";
import { CATALOGS, type TranslationKey } from "@/lib/i18n";
import { auditActionsFromUrl, auditFilterFromUrl, auditResultFromUrl } from "@/pages/audit-model";
import {
  asInspect,
  asRuntime,
  authLabel,
  connectorCallsHref,
  connectorFigures,
  connectorNotice,
  connectorStatsEndpoint,
  connectorStatsWindow,
  credentialBody,
  driverLabel,
  environmentLabel,
  offersConnectionChoice,
  offersKeyReplacement,
  presentAddress,
  renewalWay,
  returnedFromSignIn,
  SECRET_MASK,
  SIGNED_IN_PARAM,
  signInActionLabel,
  signInLine,
  toolsWithoutConfirmation,
  transportLabel,
  withoutSignInReturn,
} from "./connector-detail-model";

const de = (key: TranslationKey, values?: Record<string, string | number>) =>
  Object.entries(values ?? {}).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, String(value)),
    CATALOGS.de[key],
  );

describe("label maps", () => {
  test("every driver, transport, environment and sign-in the engine names has a German word", () => {
    expect(driverLabel("http", de)).toBe("Web-API (HTTP)");
    expect(driverLabel("graphql", de)).toBe("GraphQL-API");
    expect(driverLabel("mcp", de)).toBe("MCP-Server");
    expect(driverLabel("postgres", de)).toBe("PostgreSQL-Datenbank");
    expect(driverLabel("s3", de)).toBe("Objektspeicher (S3)");
    expect(transportLabel("http", de)).toBe("Streamable HTTP");
    expect(transportLabel("sse", de)).toBe("Server-Sent Events");
    expect(transportLabel("stdio", de)).toBe("Lokaler Prozess");
    expect(environmentLabel("prod", de)).toBe("Produktion");
    expect(environmentLabel("dev", de)).toBe("Test");
    expect(authLabel("none", [], de)).toBe("Ohne Anmeldung");
    expect(authLabel("query", [], de)).toBe("Schlüssel in der Adresse");
    expect(authLabel("bearer", [], de)).toBe("Zugriffstoken");
    expect(authLabel("basic", [], de)).toBe("Benutzername und Passwort");
    expect(authLabel("oauth2", [], de)).toBe("Anmeldung beim Anbieter (OAuth)");
    expect(authLabel("oauth2_client", [], de)).toBe("Maschinenzugang (Client-Secret)");
    expect(authLabel("oauth2_private_key", [], de)).toBe("Maschinenzugang (Schlüsselpaar)");
    expect(authLabel("aws_sigv4", [], de)).toBe("AWS-Signatur");
  });

  test("a header key names its header, never its value", () => {
    expect(authLabel("header", ["X-API-KEY"], de)).toBe("Schlüssel im Header X-API-KEY");
    expect(authLabel("header", [], de)).toBe("Schlüssel in einem Header");
  });

  test("a value this build has no word for is the engine's own, named as one — never Unbekannt", () => {
    expect(driverLabel("grpc", de)).toBe("Andere (grpc)");
    expect(transportLabel("websocket", de)).toBe("Andere (websocket)");
    expect(environmentLabel("staging", de)).toBe("Andere (staging)");
    expect(authLabel("mtls", [], de)).toBe("Andere (mtls)");
    expect(driverLabel(null, de)).toBe("");
  });
});

describe("runtime figures", () => {
  const NOW = new Date("2026-09-30T12:00:00.000Z");
  const bounds = connectorStatsWindow(NOW);
  const envelope = {
    from: "2026-09-23T12:00:00.000Z",
    to: "2026-09-30T12:00:00.000Z",
    totals: {
      calls: { total: 10, by_outcome: { success: 6, denied: 2, error: 2 } },
      latency_ms: { p50: 120 },
    },
  };

  test("read over the last seven days, fixed once", () => {
    expect(bounds).toEqual({
      window: "7d",
      from: "2026-09-23T12:00:00.000Z",
      to: "2026-09-30T12:00:00.000Z",
    });
    const endpoint = connectorStatsEndpoint("c-1", bounds);
    const query = new URLSearchParams(endpoint.slice(endpoint.indexOf("?")));
    expect(query.get("from")).toBe(bounds.from);
    expect(query.get("to")).toBe(bounds.to);
    expect(query.get("connector_id")).toBe("c-1");
  });

  test("a call the user stopped is counted, but is neither a success nor a failure", () => {
    const figures = connectorFigures(envelope, bounds);
    expect(figures).toMatchObject({ calls: 10, succeeded: 6, failed: 2, medianMs: 120 });
    expect(figures?.successRate).toBe(75);
  });

  test("no finished call has no rate; a body that is not stats is no figures", () => {
    const none = connectorFigures(
      { totals: { calls: { total: 0, by_outcome: {} }, latency_ms: { p50: 0 } } },
      bounds,
    );
    expect(none).toMatchObject({ calls: 0, successRate: null, medianMs: null });
    expect(connectorFigures({ items: [] }, bounds)).toBeNull();
  });

  test("each count opens the audit log narrowed to the same connector and the same window", () => {
    const figures = connectorFigures(envelope, bounds);
    if (!figures) throw new Error("figures expected");
    const calls = connectorCallsHref("c-1", "http", figures, "all");
    const failed = connectorCallsHref("c-1", "http", figures, "failed");
    if (!calls || !failed) throw new Error("links expected");
    const search = (href: string) => href.slice(href.indexOf("?"));
    expect(auditFilterFromUrl(search(calls))).toMatchObject({
      resourceType: "connector",
      resourceId: "c-1",
      actions: ["connector.invoked"],
      tsFrom: figures.from,
      tsTo: figures.to,
    });
    expect(auditResultFromUrl(search(calls))).toBeNull();
    expect(auditResultFromUrl(search(failed))).toBe("error");

    const mcp = connectorCallsHref("c-2", "mcp", figures, "all");
    if (!mcp) throw new Error("link expected");
    expect(auditFilterFromUrl(search(mcp)).resourceType).toBe("mcp_external_tool");
    expect(auditActionsFromUrl(search(mcp))).toEqual(["mcp_external_tool.invoked"]);
  });

  test("a counted zero has nothing to open", () => {
    const quiet = connectorFigures(
      { totals: { calls: { total: 3, by_outcome: { success: 3 } }, latency_ms: { p50: 5 } } },
      bounds,
    );
    if (!quiet) throw new Error("figures expected");
    expect(connectorCallsHref("c-1", "http", quiet, "failed")).toBeNull();
    const idle = { ...quiet, calls: 0 };
    expect(connectorCallsHref("c-1", "http", idle, "all")).toBeNull();
  });

  test("a catch-all body is not a runtime or an inspect answer", () => {
    expect(asRuntime({ items: [] })).toBeNull();
    expect(asRuntime({ recorded: true, last_success_at: null })).not.toBeNull();
    expect(asInspect({ items: [] })).toBeNull();
    expect(asInspect({ tools: [] })).not.toBeNull();
  });
});

describe("replacing a key", () => {
  test("a header connector keeps sending its key in its header", () => {
    expect(credentialBody("header", " k-123 ", "X-API-KEY")).toEqual({
      mode: "header",
      headers: { "X-API-KEY": "k-123" },
    });
    expect(credentialBody("header", "k-123", " ")).toBeNull();
  });

  test("a bearer connector posts a token; an empty key posts nothing", () => {
    expect(credentialBody("bearer", "t-1", "")).toEqual({ mode: "bearer", token: "t-1" });
    expect(credentialBody("bearer", "  ", "")).toBeNull();
  });

  test("the card offers the ways that fit the sign-in", () => {
    expect(offersKeyReplacement("header")).toBe(true);
    expect(offersKeyReplacement("bearer")).toBe(true);
    expect(offersKeyReplacement("oauth2")).toBe(false);
    expect(offersKeyReplacement("basic")).toBe(false);
    expect(offersConnectionChoice("oauth2", null)).toBe(true);
    expect(offersConnectionChoice("bearer", "connection")).toBe(true);
    expect(offersConnectionChoice("header", "header")).toBe(false);
  });
});

describe("the stored trust list", () => {
  test("reads the operator's list from the connector's config", () => {
    expect(
      toolsWithoutConfirmation({ config: { mcp: { tools_without_confirmation: ["b", "a"] } } }),
    ).toEqual(["a", "b"]);
    expect(toolsWithoutConfirmation({ config: {} })).toEqual([]);
  });
});

describe("a connector address with a kept secret", () => {
  test("shows the secret as kept, never as the engine's marker", () => {
    const masked = presentAddress(
      `https://reader:${SECRET_MASK}@db.example.org/reports?api_key=${SECRET_MASK}&format=json`,
    );
    expect(masked.keepsSecret).toBe(true);
    expect(masked.shown).toBe("https://reader:•••@db.example.org/reports?api_key=•••&format=json");
    expect(masked.shown).not.toContain("redacted");
  });

  test("an address without one is shown and copied as it is", () => {
    const plain = presentAddress("https://api.example.org/v2?format=json");
    expect(plain).toEqual({ shown: "https://api.example.org/v2?format=json", keepsSecret: false });
  });

  test("the marker is the engine's own", () => {
    const shared = readFileSync(
      resolve(import.meta.dir, "../../../../packages/shared/src/redaction.ts"),
      "utf8",
    );
    expect(shared).toContain(`export const DEFAULT_REDACTED = "${SECRET_MASK}";`);
  });

  test("the note says the secret is kept, in both languages", () => {
    expect(CATALOGS.de["connectorDetail.connection.secretKept"]).toContain("bleibt geheim");
    expect(CATALOGS.en["connectorDetail.connection.secretKept"]).toContain("kept");
  });
});

describe("coming back from a sign-in", () => {
  test("the flag is read off the address and dropped from it, alone", () => {
    expect(returnedFromSignIn("?signed_in=1")).toBe(true);
    expect(returnedFromSignIn("?tab=x&signed_in=1")).toBe(true);
    expect(returnedFromSignIn("")).toBe(false);
    expect(returnedFromSignIn("?signed=1")).toBe(false);
    expect(withoutSignInReturn("?signed_in=1")).toBe("");
    expect(withoutSignInReturn("?tab=x&signed_in=1&q=y")).toBe("?tab=x&q=y");
    expect(withoutSignInReturn("?tab=x")).toBe("?tab=x");
  });

  test("the flag and the address are the ones the engine's callback sends", () => {
    const engine = readFileSync(
      resolve(import.meta.dir, "../../../engine/src/connectors/oauth-origin.ts"),
      "utf8",
    );
    expect(engine).toContain(`export const SIGNED_IN_MARKER = "${SIGNED_IN_PARAM}";`);
    const id = "018f4b4a-6d33-7b3a-9c2d-1234567890c1";
    expect(absolute(connectorHref(id))).toBe(`/cockpit/connectors/${id}`);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the source text is checked, not its result
    expect(engine).toContain("/cockpit/connectors/${p.connector_id.toLowerCase()}");
  });

  test("a return the connector bears out is confirmed once", () => {
    expect(connectorNotice({ enabled: true, authState: "connected", returned: true })).toBe(
      "signed_in",
    );
    expect(connectorNotice({ enabled: true, authState: "unproven", returned: true })).toBe(
      "signed_in",
    );
    expect(connectorNotice({ enabled: true, authState: "connected", returned: false })).toBeNull();
  });

  test("signed in and switched off are said together", () => {
    expect(connectorNotice({ enabled: false, authState: "connected", returned: true })).toBe(
      "signed_in_off",
    );
    expect(connectorNotice({ enabled: false, authState: "connected", returned: false })).toBe(
      "off",
    );
    expect(connectorNotice({ enabled: false, authState: "expired", returned: false })).toBe("off");
  });

  test("a flag the connector does not bear out confirms nothing", () => {
    for (const authState of ["expired", "credentials_missing", "not_required"] as const) {
      expect(connectorNotice({ enabled: true, authState, returned: true })).toBeNull();
      expect(connectorNotice({ enabled: false, authState, returned: true })).toBe("off");
    }
  });
});

describe("the sign-in card's one line and one action", () => {
  test("the way to renew follows how the connector signs in", () => {
    const way = (authType: string | null, usesConnection = false, canWrite = true) =>
      renewalWay({
        authType,
        signsInAtProvider: authType === "oauth2",
        usesConnection,
        canWrite,
      });
    expect(way("oauth2")).toBe("provider");
    expect(
      renewalWay({
        authType: "oauth2_client",
        signsInAtProvider: false,
        usesConnection: false,
        canWrite: true,
      }),
    ).toBeNull();
    expect(way("oauth2", true)).toBe("connection");
    expect(way("bearer", true)).toBe("connection");
    expect(way("header")).toBe("key");
    expect(way("bearer")).toBe("key");
    expect(way("basic")).toBeNull();
    expect(way("oauth2", false, false)).toBeNull();
    expect(way("oauth2", true, false)).toBeNull();
  });

  test("a refused sign-in says what is the case and what the button does", () => {
    expect(de(signInLine("expired", "provider") as TranslationKey)).toBe(
      "Der Anbieter lehnt die gespeicherte Anmeldung ab. „Neu anmelden“ führt zum Anbieter und wieder hierher.",
    );
    expect(de(signInLine("expired", "key") as TranslationKey)).toContain("„Neu anmelden“ öffnet");
    expect(signInLine("expired", "connection")).toBe("connectorCredentials.renewViaConnection");
    expect(signInLine("expired", null)).toBe("connectorCredentials.lostReadOnly");
  });

  test("no line sends the reader to a connection test for a way the button already is", () => {
    for (const state of ["expired", "credentials_missing"] as const)
      for (const way of ["provider", "key", "connection", null] as const) {
        const key = signInLine(state, way);
        expect(key).not.toBeNull();
        for (const catalog of [CATALOGS.de, CATALOGS.en])
          expect(catalog[key as TranslationKey]).not.toMatch(/Verbindungstest|Test the connection/);
      }
  });

  test('a first sign-in is not called "again", in the line or on the button', () => {
    expect(signInActionLabel("credentials_missing")).toBe("connectorCredentials.signIn");
    expect(signInActionLabel("expired")).toBe("connectorCredentials.renew");
    expect(de(signInLine("credentials_missing", "provider") as TranslationKey)).toContain(
      "„Anmelden“ führt zum Anbieter",
    );
    expect(de(signInLine("credentials_missing", "key") as TranslationKey)).toContain("„Anmelden“");
    expect(signInLine("credentials_missing", null)).toBe("connectors.auth.credentialsMissingHint");
  });

  test("a sign-in that works needs no sentence; an unproven one says how to find out", () => {
    expect(signInLine("connected", "provider")).toBeNull();
    expect(signInLine("not_required", null)).toBeNull();
    expect(signInLine("unproven", "provider")).toBe("connectors.auth.unprovenHint");
  });

  test("every line and label exists in both languages", () => {
    const keys: TranslationKey[] = [
      "connectorCredentials.renewAtProvider",
      "connectorCredentials.lostReadOnly",
      "connectorCredentials.signIn",
      "connectorCredentials.signInAtProvider",
      "connectorCredentials.enterKey",
      "connectorCredentials.missingScopes",
      "connectorState.off",
      "connectorState.signedIn",
      "connectorState.signedInOff",
      "connectorState.offBody",
      "connectorState.enable",
      "connectorState.enabled",
      "connectorState.enableFailed",
    ];
    for (const key of keys) {
      expect(CATALOGS.de[key].length).toBeGreaterThan(0);
      expect(CATALOGS.en[key].length).toBeGreaterThan(0);
      expect(CATALOGS.de[key]).not.toBe(CATALOGS.en[key]);
    }
  });
});
