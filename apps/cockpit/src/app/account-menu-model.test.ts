import { describe, expect, test } from "bun:test";
import { accountMenuFallbacks } from "./account-menu-model";

describe("accountMenuFallbacks", () => {
  test("an admin finds API access and the pause in Settings, so the menu stays at the dummy's entries", () => {
    expect(
      accountMenuFallbacks({
        permissions: ["api_key:read", "settings:read"],
        settingAreas: ["profile", "setup", "rules", "access", "notifications"],
      }),
    ).toEqual({ apiAccess: false, pause: false });
  });

  test("API access stays in the menu when Settings has no access area for this person", () => {
    expect(
      accountMenuFallbacks({
        permissions: ["api_key:read"],
        settingAreas: ["profile", "setup", "rules", "notifications"],
      }).apiAccess,
    ).toBe(true);
  });

  test("no API access entry for someone without any of its reads", () => {
    expect(accountMenuFallbacks({ permissions: [], settingAreas: ["profile"] }).apiAccess).toBe(
      false,
    );
  });

  test("the personal pause stays in the menu when Settings shows no notifications area", () => {
    expect(
      accountMenuFallbacks({ permissions: [], settingAreas: ["profile", "setup", "rules"] }).pause,
    ).toBe(true);
  });
});
