import { describe, expect, test } from "bun:test";
import { dispatchAuthRedirectSlash } from "../repl/slash/handlers/auth-redirects.ts";

describe("dispatchAuthRedirectSlash", () => {
  test("returns the redirect banner for /login, /logout, /tenant", () => {
    expect(dispatchAuthRedirectSlash("login")).toMatch(/subkit login/);
    expect(dispatchAuthRedirectSlash("logout")).toMatch(/subkit logout/);
    expect(dispatchAuthRedirectSlash("tenant")).toMatch(/subkit tenants/);
  });

  test("returns undefined for unknown names — caller falls through", () => {
    expect(dispatchAuthRedirectSlash("login-anything")).toBeUndefined();
    expect(dispatchAuthRedirectSlash("profile")).toBeUndefined();
    expect(dispatchAuthRedirectSlash("")).toBeUndefined();
  });
});
