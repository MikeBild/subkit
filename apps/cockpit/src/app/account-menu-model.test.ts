import { describe, expect, test } from "bun:test";
import { visibleSettingAreas } from "@/features/settings";
import { ACCOUNT_MENU_HREF, accountMenu, HEADER_ACTIONS } from "./account-menu-model";
import { visibleSidebarNavigation } from "./navigation";

const ROLES = {
  admin: {
    permissions: [
      "settings:read",
      "settings:write:global",
      "identity:read",
      "identity:write",
      "notification:read",
      "api_key:read",
      "connection:read",
      "stats:read",
    ],
    isOwner: true,
  },
  member: {
    permissions: ["notification:read", "api_key:read", "connection:read", "workflow:read"],
    isOwner: false,
  },
  enduser: {
    permissions: ["workflow:read", "workflow:run", "conversation:read", "knowledge:read"],
    isOwner: false,
  },
} as const;

function menuFor(role: keyof typeof ROLES, installOffered = false) {
  const { permissions, isOwner } = ROLES[role];
  return accountMenu({
    installOffered,
    permissions,
    settingAreas: visibleSettingAreas({ permissions, isOwner, origin: "self_hosted" }),
  });
}

const everyone = (Object.keys(ROLES) as (keyof typeof ROLES)[]).flatMap((role) => [
  menuFor(role, true),
  menuFor(role, false),
]);

describe("the account menu", () => {
  test("an admin reaches the pause and API access in Settings, so the menu shows neither", () => {
    expect(menuFor("admin", true)).toEqual([
      ["profile"],
      ["language", "theme"],
      ["docs", "releaseNotes", "install"],
      ["signOut"],
    ]);
  });

  test("a member without the access area finds API access in the menu", () => {
    expect(menuFor("member")).toEqual([
      ["profile"],
      ["language", "theme"],
      ["apiAccess"],
      ["docs", "releaseNotes"],
      ["signOut"],
    ]);
  });

  test("an enduser without the notifications area finds the pause in the menu, and no API access", () => {
    expect(menuFor("enduser")).toEqual([
      ["profile"],
      ["language", "theme"],
      ["pause"],
      ["docs", "releaseNotes"],
      ["signOut"],
    ]);
  });

  test("install appears only where it applies", () => {
    expect(menuFor("member", false).flat()).not.toContain("install");
  });

  test("every entry appears once", () => {
    for (const menu of everyone) expect(new Set(menu.flat()).size).toBe(menu.flat().length);
  });

  test("no entry repeats an action of the header bar", () => {
    for (const menu of everyone)
      for (const entry of menu.flat())
        expect((HEADER_ACTIONS as readonly string[]).includes(entry)).toBe(false);
  });

  test("no entry leads to a page the sidebar already offers", () => {
    const sidebar = visibleSidebarNavigation(ROLES.admin.permissions).flatMap((group) =>
      group.items.map((item) => item.path),
    );
    for (const href of Object.values(ACCOUNT_MENU_HREF)) expect(sidebar).not.toContain(href);
  });
});
