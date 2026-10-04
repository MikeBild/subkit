import { describe, expect, test } from "bun:test";
import { McpPreflightError } from "./registry.ts";
import { resolveStaticAuthHeaders } from "./session-auth.ts";

describe("resolveStaticAuthHeaders", () => {
  test("refuses a line break or NUL in any static credential without quoting it", () => {
    const secret = "sk_live_pasted_secret_value";
    const cases = [
      [{ kind: "bearer" }, { mode: "bearer", token: `${secret}\n` }],
      [{ kind: "basic" }, { mode: "basic", username: "mike", password: `${secret}\r\n` }],
      [{ kind: "basic" }, { mode: "basic", username: `mi\0ke`, password: secret }],
      [{ kind: "header" }, { mode: "header", headers: { "X-Api-Key": `${secret}\n` } }],
    ] as const;
    for (const [auth, value] of cases) {
      let error: unknown;
      try {
        resolveStaticAuthHeaders(auth, value);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(McpPreflightError);
      expect((error as McpPreflightError).error_code).toBe("credential_invalid");
      expect(String((error as Error).message)).not.toContain("sk_live");
      expect(String((error as Error).message)).not.toContain("mike");
    }
  });

  test("builds the same bearer header used by persisted MCP sessions", () => {
    expect(
      resolveStaticAuthHeaders({ kind: "bearer" }, { mode: "bearer", token: "secret" }),
    ).toEqual({ Authorization: "Bearer secret" });
  });

  test("builds RFC 7617 basic auth", () => {
    expect(
      resolveStaticAuthHeaders(
        { kind: "basic" },
        { mode: "basic", username: "mike", password: "token" },
      ),
    ).toEqual({ Authorization: `Basic ${Buffer.from("mike:token").toString("base64")}` });
  });

  test("rejects a credential whose mode disagrees with the MCP auth shape", () => {
    expect(() =>
      resolveStaticAuthHeaders(
        { kind: "bearer" },
        { mode: "basic", username: "mike", password: "token" },
      ),
    ).toThrow("expected bearer credential");
  });

  test("refuses to treat OAuth credentials as static draft headers", () => {
    expect(() => resolveStaticAuthHeaders({ kind: "oauth2" }, null)).toThrow(
      "requires its persisted OAuth provider",
    );
  });

  test("mounts a header credential under its own name, as for an http connector", () => {
    expect(
      resolveStaticAuthHeaders(
        { kind: "header" },
        { mode: "header", headers: { "X-API-KEY": "secret" } },
      ),
    ).toEqual({ "X-API-KEY": "secret" });
  });

  test("refuses a header the MCP transport sets itself", () => {
    expect(() =>
      resolveStaticAuthHeaders(
        { kind: "header" },
        { mode: "header", headers: { "Mcp-Session-Id": "x" } },
      ),
    ).toThrow("cannot carry a credential");
  });

  test("refuses a bearer credential on a header server", () => {
    expect(() =>
      resolveStaticAuthHeaders({ kind: "header" }, { mode: "bearer", token: "secret" }),
    ).toThrow("expected header credential");
  });
});
