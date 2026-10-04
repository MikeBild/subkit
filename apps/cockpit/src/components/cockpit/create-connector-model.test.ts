import { describe, expect, test } from "bun:test";
import { translate } from "@/lib/i18n";
import {
  afterCreateTab,
  type ConnectorSignIn,
  type ConnectorTarget,
  connectorCreateBody,
  EMPTY_OAUTH_CLIENT,
  manualConnectorProblem,
  needsOAuthClient,
  needsSecret,
} from "./create-connector-model";

const TARGETS: ConnectorTarget[] = ["web", "mcp"];
const SIGN_INS: ConnectorSignIn[] = ["account", "key", "none"];

describe("connector by hand: what it connects, then how SubKit signs in", () => {
  test("only an access key is typed into the form", () => {
    expect(needsSecret("key")).toBe(true);
    expect(needsSecret("account")).toBe(false);
    expect(needsSecret("none")).toBe(false);
  });

  test("the request carries the engine's driver and auth type for every pair", () => {
    const expected: Record<string, string[]> = {
      "web/account": ["http", "oauth2"],
      "web/key": ["http", "bearer"],
      "web/none": ["http", "none"],
      "mcp/account": ["mcp", "oauth2"],
      "mcp/key": ["mcp", "bearer"],
      "mcp/none": ["mcp", "none"],
    };
    for (const target of TARGETS)
      for (const signIn of SIGN_INS) {
        const body = connectorCreateBody({
          target,
          signIn,
          name: "  Billing  ",
          slug: "billing",
          address: " https://api.example.com ",
        });
        expect<string[]>([body.driver, body.auth_type]).toEqual(
          expected[`${target}/${signIn}`] ?? [],
        );
        expect(body).toMatchObject({
          name: "Billing",
          slug: "billing",
          environment: "prod",
          base_url: "https://api.example.com",
        });
      }
  });

  test("without a sign-in leaving the page, an MCP server opens on its tools, a web service on its connection", () => {
    expect(afterCreateTab("mcp")).toBe("werkzeuge");
    expect(afterCreateTab("web")).toBe("verbindung");
  });

  test("only a web service signed in with an account asks for its OAuth app", () => {
    for (const target of TARGETS)
      for (const signIn of SIGN_INS)
        expect(needsOAuthClient(target, signIn)).toBe(target === "web" && signIn === "account");
  });

  test("a web service with an account carries its OAuth app; nothing else carries one", () => {
    const oauth = {
      issuer: " https://accounts.example.com ",
      clientId: " app-1 ",
      clientSecret: " s3cret ",
      scopes: " read, write  admin ",
    };
    const base = { name: "Billing", slug: "billing", address: "https://api.example.com", oauth };
    expect(connectorCreateBody({ ...base, target: "web", signIn: "account" }).config).toEqual({
      oauth: {
        issuer_url: "https://accounts.example.com",
        client_id: "app-1",
        client_secret: "s3cret",
        scope: "read write admin",
      },
    });
    expect(
      connectorCreateBody({
        ...base,
        target: "web",
        signIn: "account",
        oauth: { ...oauth, clientSecret: "  ", scopes: "" },
      }).config,
    ).toEqual({ oauth: { issuer_url: "https://accounts.example.com", client_id: "app-1" } });
    for (const [target, signIn] of [
      ["mcp", "account"],
      ["web", "key"],
      ["web", "none"],
      ["mcp", "key"],
    ] as const)
      expect(connectorCreateBody({ ...base, target, signIn }).config).toBeUndefined();
  });

  test("the form stops at the first problem, and never makes a connector no one can sign in", () => {
    const ok = {
      target: "web" as ConnectorTarget,
      signIn: "account" as ConnectorSignIn,
      slug: "billing",
      address: "https://api.example.com",
      secret: "",
      oauth: { ...EMPTY_OAUTH_CLIENT, issuer: "https://accounts.example.com", clientId: "app" },
      callbackUrl: "https://engine.example.com/v1/oauth/callback",
    };
    expect(manualConnectorProblem(ok)).toBeNull();
    expect(manualConnectorProblem({ ...ok, slug: "" })).toBe("create.nameMissing");
    expect(manualConnectorProblem({ ...ok, address: "http://api" })).toBe(
      "create.connector.addressInvalid",
    );
    expect(manualConnectorProblem({ ...ok, oauth: { ...ok.oauth, issuer: "" } })).toBe(
      "create.connector.issuerInvalid",
    );
    expect(manualConnectorProblem({ ...ok, oauth: { ...ok.oauth, clientId: " " } })).toBe(
      "create.connector.clientIdMissing",
    );
    expect(manualConnectorProblem({ ...ok, callbackUrl: null })).toBe("signIn.failed.publicUrl");
    expect(
      manualConnectorProblem({
        ...ok,
        target: "mcp",
        oauth: EMPTY_OAUTH_CLIENT,
        callbackUrl: null,
      }),
    ).toBe("signIn.failed.publicUrl");
    expect(manualConnectorProblem({ ...ok, target: "mcp", oauth: EMPTY_OAUTH_CLIENT })).toBeNull();
    expect(manualConnectorProblem({ ...ok, signIn: "key" })).toBe("create.connector.secretMissing");
    expect(
      manualConnectorProblem({
        ...ok,
        signIn: "none",
        oauth: EMPTY_OAUTH_CLIENT,
        callbackUrl: null,
      }),
    ).toBeNull();
  });

  test("the choices are short labels, with no protocol jargon", () => {
    const labels = [
      "create.connector.target",
      "create.connector.target.web",
      "create.connector.target.mcp",
      "create.connector.signIn",
      "create.connector.signIn.account",
      "create.connector.signIn.key",
      "create.connector.signIn.none",
      "create.connector.secret",
      "create.connector.issuer",
      "create.connector.clientId",
      "create.connector.clientSecret",
      "create.connector.scopes",
      "create.connector.callback",
    ] as const;
    for (const locale of ["de", "en"] as const)
      for (const key of labels) {
        const label = translate(locale, key);
        expect(label.split(/\s+/).length).toBeLessThanOrEqual(3);
        expect(label).not.toMatch(/OAuth|API/);
      }
    expect(translate("de", "create.connector.issuer")).toBe("Anmeldedienst");
    expect(translate("de", "create.connector.secret")).toBe("Zugangsschlüssel");
  });
});
