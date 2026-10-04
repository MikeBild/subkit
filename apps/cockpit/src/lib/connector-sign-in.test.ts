import { describe, expect, test } from "bun:test";
import { ApiError } from "@/api/client";
import { type TranslationKey, translate } from "@/lib/i18n";
import { connectorSignIn, signInFailure } from "./connector-sign-in";

const de = (key: TranslationKey, values?: Record<string, string | number>) =>
  Object.entries(values ?? {}).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, String(value)),
    translate("de", key),
  );

describe("a connector's own sign-in", () => {
  test("is the route the engine states, never one chosen by driver", () => {
    const mcp = { driver: "mcp", auth_type: "oauth2", sign_in: { kind: "mcp", start: "/a" } };
    expect(connectorSignIn(mcp)).toEqual({ kind: "mcp", start: "/a" });
    expect(
      connectorSignIn({ driver: "http", sign_in: { kind: "oauth", start: "/v1/x/oauth/start" } }),
    ).toEqual({ kind: "oauth", start: "/v1/x/oauth/start" });
    // No statement, no sign-in — even for an oauth2 connector.
    expect(connectorSignIn({ driver: "mcp", auth_type: "oauth2" })).toBeNull();
    expect(connectorSignIn({ sign_in: null })).toBeNull();
    expect(connectorSignIn({ sign_in: { kind: "other", start: "/a" } })).toBeNull();
    expect(connectorSignIn({ sign_in: { kind: "oauth", start: "" } })).toBeNull();
    expect(connectorSignIn(null)).toBeNull();
  });

  test("a sign-in that cannot start says why, in one short line", () => {
    const refused = (code: string, message = "engine words") =>
      new ApiError(code === "engine_public_url_missing" ? 400 : 502, { code, message }, null);
    expect(signInFailure(refused("engine_public_url_missing"), de)).toBe(
      de("signIn.failed.publicUrl"),
    );
    expect(signInFailure(refused("oauth_start_failed"), de)).toBe(de("signIn.failed.service"));
    expect(signInFailure(refused("mcp_authorization_failed"), de)).toBe(de("signIn.failed.mcp"));
    // A reason this build has no line for is said in the engine's words.
    expect(signInFailure(refused("bad_request", "no client_id"), de)).toBe(
      "Anmeldung nicht gestartet: no client_id",
    );
    expect(signInFailure(refused("constructor", "x"), de)).toBe("Anmeldung nicht gestartet: x");
    expect(signInFailure(new Error("network"), de)).toBe(de("connectorCredentials.renewFailed"));
  });
});
