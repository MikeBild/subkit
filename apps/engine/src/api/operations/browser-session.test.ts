import { describe, expect, test } from "bun:test";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { requireBrowserSession } from "./browser-session.ts";
import { isRejection } from "./index.ts";

const base: ResolvedPrincipal = {
  provider: "local",
  kind: "user",
  id: "u1",
  tenant_id: "t1",
  roles: [],
};

describe("requireBrowserSession", () => {
  test("a person in a browser session passes through unchanged", () => {
    const principal: ResolvedPrincipal = {
      ...base,
      auth_source: { kind: "browser_session", session_id: "s1" },
    };
    expect(requireBrowserSession(principal, "msg")).toBe(principal);
  });

  test("an API key of a person is rejected with human_confirmation_required", () => {
    const out = requireBrowserSession(
      { ...base, auth_source: { kind: "api_key", api_key_id: "k", credential_version: "1" } },
      "sign in first",
    );
    expect(isRejection(out)).toBe(true);
    expect(out).toMatchObject({
      status: 403,
      code: "human_confirmation_required",
      message: "sign in first",
    });
  });

  test("a system account is rejected even with a session-shaped source", () => {
    const out = requireBrowserSession(
      {
        ...base,
        kind: "system_account",
        auth_source: { kind: "browser_session", session_id: "s" },
      },
      "msg",
    );
    expect(isRejection(out)).toBe(true);
  });

  test("a person without an auth source is rejected", () => {
    expect(isRejection(requireBrowserSession(base, "msg"))).toBe(true);
  });
});
