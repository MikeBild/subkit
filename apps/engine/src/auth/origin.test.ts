import { describe, expect, test } from "bun:test";
import { principalOrigin } from "./origin.ts";
import type { ResolvedPrincipal } from "./types.ts";

const base: ResolvedPrincipal = {
  provider: "api_key",
  kind: "user",
  id: "user-1",
  tenant_id: "tenant-1",
  roles: ["admin"],
};

describe("principalOrigin", () => {
  test("an API-key principal is attributed to its key", () => {
    expect(principalOrigin({ ...base, api_key_id: "key-abc" })).toBe("api_key:key-abc");
  });

  test("an OAuth principal is attributed to its client registration", () => {
    expect(principalOrigin({ ...base, provider: "mcp_oauth", oauth_client_id: "client-xyz" })).toBe(
      "mcp_oauth:client-xyz",
    );
  });

  test("two OAuth clients for the same user attribute differently", () => {
    const a = principalOrigin({ ...base, provider: "mcp_oauth", oauth_client_id: "client-a" });
    const b = principalOrigin({ ...base, provider: "mcp_oauth", oauth_client_id: "client-b" });
    expect(a).not.toBe(b);
  });

  test("a session-backed principal has no channel to attribute", () => {
    expect(principalOrigin({ ...base, provider: "browser_session", session_id: "sess-1" })).toBe(
      "browser_session:session",
    );
    expect(principalOrigin(base)).toBeNull();
  });

  test("the key wins over the OAuth registration when a principal carries both", () => {
    expect(
      principalOrigin({
        ...base,
        api_key_id: "key-abc",
        oauth_client_id: "client-xyz",
        session_id: "sess-1",
      }),
    ).toBe("api_key:key-abc");
  });
});
