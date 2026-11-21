import type { SettingAreaId } from "@/features/settings";
import { navigationVisible } from "./navigation";

export const HEADER_ACTIONS = ["notifications", "feedback", "sidePanel"] as const;

export type AccountMenuEntry =
  | "profile"
  | "language"
  | "theme"
  | "apiAccess"
  | "pause"
  | "docs"
  | "releaseNotes"
  | "install"
  | "signOut";

export const ACCOUNT_MENU_HREF: Readonly<Partial<Record<AccountMenuEntry, string>>> = {
  profile: "/settings?area=profile",
  apiAccess: "/api-access",
  docs: "/docs",
};

export function accountMenu(input: {
  installOffered: boolean;
  permissions: readonly string[];
  settingAreas: readonly SettingAreaId[];
}): AccountMenuEntry[][] {
  const apiAccess =
    !input.settingAreas.includes("access") && navigationVisible(input.permissions, "/api-access");
  const pause = !input.settingAreas.includes("notifications");
  const reachable: AccountMenuEntry[] = [
    ...(apiAccess ? (["apiAccess"] as const) : []),
    ...(pause ? (["pause"] as const) : []),
  ];
  return [
    ["profile"],
    ["language", "theme"],
    ...(reachable.length > 0 ? [reachable] : []),
    ["docs", "releaseNotes", ...(input.installOffered ? (["install"] as const) : [])],
    ["signOut"],
  ];
}
