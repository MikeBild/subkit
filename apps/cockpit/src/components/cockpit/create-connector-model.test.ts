import { describe, expect, test } from "bun:test";
import { translate } from "@/lib/i18n";
import {
  afterCreateTab,
  type ConnectorEditDraft,
  type ConnectorEditPrior,
  type ConnectorSignIn,
  type ConnectorTarget,
  connectorCreateBody,
  connectorEditPlan,
  connectorEditProblem,
  connectorTargetOf,
  DEFAULT_SIGN_IN,
  EMPTY_OAUTH_CLIENT,
  manualConnectorProblem,
  needsOAuthClient,
  needsSecret,
  oauthClientOf,
  signInOf,
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
    expect(afterCreateTab("mcp")).toBe("tools");
    expect(afterCreateTab("web")).toBe("connection");
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

const PRIOR: ConnectorEditPrior = {
  driver: "http",
  authType: "bearer",
  name: "Billing",
  address: "https://api.example.com",
  config: {},
};

function draftOf(overrides: Partial<ConnectorEditDraft> = {}): ConnectorEditDraft {
  return {
    name: "Billing",
    address: "https://api.example.com",
    signIn: "key",
    secret: "",
    header: "",
    oauth: EMPTY_OAUTH_CLIENT,
    ...overrides,
  };
}

describe("editing a connector's sign-in", () => {
  test("a new connector starts with a key, the shortest way that signs in", () => {
    expect(DEFAULT_SIGN_IN).toBe("key");
  });

  test("only none, key and account are choices; other kinds keep their own name", () => {
    expect(signInOf("none")).toBe("none");
    expect(signInOf("bearer")).toBe("key");
    expect(signInOf("oauth2")).toBe("account");
    expect(signInOf("header")).toBeNull();
    expect(signInOf("aws_sigv4")).toBeNull();
    expect(connectorTargetOf("graphql")).toBeNull();
  });

  test("saving without a change sends only the name and replaces nothing", () => {
    const plan = connectorEditPlan(PRIOR, draftOf());
    expect(plan).toEqual({ patch: { name: "Billing" }, credential: null, startSignIn: false });
  });

  test("a typed key replaces the stored one without touching the sign-in kind", () => {
    const plan = connectorEditPlan(PRIOR, draftOf({ secret: " new-token " }));
    expect(plan.patch.auth_type).toBeUndefined();
    expect(plan.credential).toEqual({ mode: "bearer", token: "new-token" });
  });

  test("a header connector saved unchanged stays a header connector", () => {
    const prior = { ...PRIOR, authType: "header" };
    const plan = connectorEditPlan(
      prior,
      draftOf({ signIn: null, header: "X-Api-Key", secret: "v" }),
    );
    expect(plan.patch.auth_type).toBeUndefined();
    expect(plan.credential).toEqual({ mode: "header", headers: { "X-Api-Key": "v" } });
  });

  test("switching to none drops the sign-in", () => {
    const plan = connectorEditPlan(PRIOR, draftOf({ signIn: "none" }));
    expect(plan.patch.auth_type).toBe("none");
    expect(plan.credential).toBeNull();
  });

  test("switching to a key needs the key and lets the key request switch the kind", () => {
    const prior = { ...PRIOR, authType: "none" };
    expect(connectorEditProblem(prior, draftOf(), null)).toBe("create.connector.secretMissing");
    const plan = connectorEditPlan(prior, draftOf({ secret: "k" }));
    expect(plan.patch.auth_type).toBeUndefined();
    expect(plan.credential).toEqual({ mode: "bearer", token: "k" });
  });

  test("switching a web connector to an account sends the client and starts the sign-in", () => {
    const prior = { ...PRIOR, config: { timeout_ms: 5000 } };
    const draft = draftOf({
      signIn: "account",
      oauth: { issuer: "https://id.example.com", clientId: "c", clientSecret: "", scopes: "a b" },
    });
    expect(connectorEditProblem(prior, draft, null)).toBe("signIn.failed.publicUrl");
    expect(connectorEditProblem(prior, draft, "https://sk.example.com/cb")).toBeNull();
    const plan = connectorEditPlan(prior, draft);
    expect(plan.startSignIn).toBe(true);
    expect(plan.patch.auth_type).toBe("oauth2");
    expect(plan.patch.config).toEqual({
      timeout_ms: 5000,
      oauth: { issuer_url: "https://id.example.com", client_id: "c", scope: "a b" },
    });
  });

  test("an MCP connector signs in with an account without a client to type", () => {
    const prior = { ...PRIOR, driver: "mcp" };
    const plan = connectorEditPlan(prior, draftOf({ signIn: "account" }));
    expect(plan.patch).toEqual({ name: "Billing", auth_type: "oauth2" });
    expect(connectorEditProblem(prior, draftOf({ signIn: "account" }), "https://cb")).toBeNull();
  });

  test("the stored client secret is kept while the issuer stays, and dropped when it moves", () => {
    const config = {
      oauth: {
        issuer_url: "https://id.example.com",
        client_id: "c",
        client_secret: "***redacted***",
        token_endpoint: "https://id.example.com/token",
        scope: "a",
      },
    };
    const prior = { ...PRIOR, authType: "oauth2", config };
    const same = connectorEditPlan(
      prior,
      draftOf({ signIn: "account", oauth: { ...oauthClientOf(config), scopes: "" } }),
    );
    expect(same.patch.config).toEqual({
      oauth: {
        issuer_url: "https://id.example.com",
        client_id: "c",
        client_secret: "***redacted***",
        token_endpoint: "https://id.example.com/token",
      },
    });
    const moved = connectorEditPlan(
      prior,
      draftOf({
        signIn: "account",
        oauth: { ...oauthClientOf(config), issuer: "https://other.example.com" },
      }),
    );
    expect(moved.patch.config).toEqual({
      oauth: { issuer_url: "https://other.example.com", client_id: "c", scope: "a" },
    });
  });

  test("the stored secrets are never put back into the form", () => {
    expect(oauthClientOf({ oauth: { client_secret: "***redacted***" } }).clientSecret).toBe("");
  });
});
