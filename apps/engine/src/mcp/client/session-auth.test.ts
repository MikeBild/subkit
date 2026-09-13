import { describe, expect, test } from "bun:test";

import { resolveStaticAuthHeaders } from "./session-auth.ts";

describe("resolveStaticAuthHeaders", () => {
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
});
