import { describe, expect, test } from "bun:test";
import { loginHref } from "@/app/login-href";
import { vaultItemFromUrl, withVaultItem } from "./payments";

const ITEM = "0b8a3c1e-5d2f-4e6a-9c7b-1f2e3d4c5b6a";

describe("sign in again before revealing", () => {
  test("the link forces a fresh sign-in and returns to the open vault entry", () => {
    const back = withVaultItem({ pathname: "/cockpit/settings", search: "?area=vault" }, ITEM);
    const href = loginHref(back, { reauth: true });
    const url = new URL(href, "https://subkit.invalid");
    expect(url.pathname).toBe("/v1/identity/cockpit-login");
    expect(url.searchParams.get("reauth")).toBe("1");
    const returnTo = url.searchParams.get("return_to") ?? "";
    expect(returnTo).toBe(`/cockpit/settings?area=vault&item=${ITEM}`);
    expect(vaultItemFromUrl(new URL(returnTo, "https://subkit.invalid").search)).toBe(ITEM);
  });

  test("inside an installation the link stays under its API prefix", () => {
    const href = loginHref(
      withVaultItem(
        { pathname: "/cockpit/i/11111111-2222-4333-8444-555555555555/settings", search: "" },
        ITEM,
      ),
      { reauth: true },
    );
    expect(href).toStartWith(
      "/cockpit/i/11111111-2222-4333-8444-555555555555/api/v1/identity/cockpit-login?",
    );
    expect(href).toEndWith("&reauth=1");
  });

  test("a plain sign-in link has no reauth flag and a closed entry leaves no item", () => {
    expect(loginHref({ pathname: "/cockpit", search: "" })).not.toContain("reauth");
    expect(withVaultItem({ pathname: "/cockpit/settings", search: `?item=${ITEM}` }, null)).toEqual(
      { pathname: "/cockpit/settings", search: "" },
    );
    expect(vaultItemFromUrl("?item=not-an-id")).toBeNull();
  });
});
