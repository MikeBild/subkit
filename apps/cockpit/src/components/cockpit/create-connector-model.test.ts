import { describe, expect, test } from "bun:test";
import { translate } from "@/lib/i18n";
import {
  afterCreate,
  type ConnectorSignIn,
  type ConnectorTarget,
  connectorCreateBody,
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

  test("an account sign-in starts at once, by the way the kind supports", () => {
    expect(afterCreate("web", "account")).toEqual({ signInPath: "oauth/start", tab: "verbindung" });
    expect(afterCreate("mcp", "account")).toEqual({
      signInPath: "mcp/authorize",
      tab: "werkzeuge",
    });
    for (const signIn of ["key", "none"] satisfies ConnectorSignIn[]) {
      expect(afterCreate("web", signIn)).toEqual({ signInPath: null, tab: "verbindung" });
      expect(afterCreate("mcp", signIn)).toEqual({ signInPath: null, tab: "werkzeuge" });
    }
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
    ] as const;
    for (const locale of ["de", "en"] as const)
      for (const key of labels) {
        const label = translate(locale, key);
        expect(label.split(/\s+/).length).toBeLessThanOrEqual(3);
        expect(label).not.toMatch(/OAuth|API/);
      }
    expect(translate("de", "create.connector.secret")).toBe("Zugangsschlüssel");
  });
});
