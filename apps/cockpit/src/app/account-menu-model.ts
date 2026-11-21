import type { SettingAreaId } from "@/pages/settings-areas";
import { navigationVisible } from "./navigation";

export interface AccountMenuFallbacks {
  apiAccess: boolean;
  pause: boolean;
}

export function accountMenuFallbacks(input: {
  permissions: readonly string[];
  settingAreas: readonly SettingAreaId[];
}): AccountMenuFallbacks {
  return {
    apiAccess:
      !input.settingAreas.includes("access") && navigationVisible(input.permissions, "/api-access"),
    pause: !input.settingAreas.includes("notifications"),
  };
}
