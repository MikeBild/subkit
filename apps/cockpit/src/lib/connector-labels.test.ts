import { describe, expect, test } from "bun:test";
import { authLabel, driverLabel, environmentLabel, transportLabel } from "./connector-labels";
import { CATALOGS, type TranslationKey } from "./i18n";

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
    expect(environmentLabel("prod", de)).toBe("Echtbetrieb");
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
