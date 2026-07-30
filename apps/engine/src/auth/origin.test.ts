// `principalOrigin` — the channel attribution that per-client measurement rests on.
//
// The property under test is not the string format but WHERE the value comes
// from: every term is credential-derived. A client's self-reported `clientInfo`
// must never be able to reach this function, because the whole reason the field
// exists is to be trustworthy when `clientInfo` is not.

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
    // This is the case the whole field exists for: one person authorises two
    // browser clients, and their elicitation outcomes must stay separable.
    const a = principalOrigin({ ...base, provider: "mcp_oauth", oauth_client_id: "client-a" });
    const b = principalOrigin({ ...base, provider: "mcp_oauth", oauth_client_id: "client-b" });
    expect(a).not.toBe(b);
  });

  test("a session-backed principal has no channel to attribute", () => {
    // Null rather than a placeholder: a person in a browser is not a registered
    // client. Inventing a value here would put a fake channel into the matrix.
    expect(principalOrigin({ ...base, provider: "browser_session", session_id: "sess-1" })).toBe(
      "browser_session:session",
    );
    expect(principalOrigin(base)).toBeNull();
  });

  test("the key wins over the OAuth registration when a principal carries both", () => {
    // Deterministic precedence so the same principal never yields two different
    // attributions across call sites — an unstable key would silently split one
    // channel into two rows in any aggregate.
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
