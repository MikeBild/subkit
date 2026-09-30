// The connector detail page's decisions: the words for the engine's machine
// values (and the fallback for one this build has no word for), the runtime
// figures and the audit links that count the same thing over the same window
// (§10.1), and the credential body a replaced key is posted as.

import { describe, expect, test } from "bun:test";
import { CATALOGS, type TranslationKey } from "@/lib/i18n";
import { auditActionsFromUrl, auditFilterFromUrl, auditResultFromUrl } from "@/pages/audit-model";
import {
  asInspect,
  asRuntime,
  authLabel,
  connectorCallsHref,
  connectorFigures,
  connectorStatsEndpoint,
  connectorStatsWindow,
  credentialBody,
  driverLabel,
  environmentLabel,
  offersConnectionChoice,
  offersKeyReplacement,
  toolsWithoutConfirmation,
  transportLabel,
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
