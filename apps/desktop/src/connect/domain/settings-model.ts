import type { LocaleSetting, MessageKey } from "../../shared/i18n.ts";
import type { ConnectState } from "../../shared/ipc.ts";
import type { QuietHours } from "../../shared/quiet-hours.ts";
import { hostOf } from "../../shared/server-address.ts";
import { updateAction, updateStatus } from "../../shared/updates.ts";

export interface ServerRow {
  profileId: string;
  host: string;
  active: boolean;
  primary: { label: MessageKey; command: "open" | "sign-in" };
}

export interface SettingsModel {
  servers: ServerRow[];
  launchAtLogin: boolean;
  quietHours: QuietHours;
  locale: LocaleSetting;
  update: {
    status: { key: MessageKey; vars: Record<string, string | number> };
    progress: number | null;
    action: { label: MessageKey; enabled: boolean; primary: boolean } | null;
  };
}

export function settingsFor(state: ConnectState): SettingsModel {
  const { update } = state;
  const action = updateAction(update);
  return {
    servers: state.profiles.map((profile) => ({
      profileId: profile.id,
      host: hostOf(profile.serverOrigin),
      active: profile.active,
      primary: profile.signedIn
        ? { label: "profiles.open", command: "open" }
        : { label: "profiles.signIn", command: "sign-in" },
    })),
    launchAtLogin: state.settings.launchAtLogin,
    quietHours: state.settings.quietHours,
    locale: state.settings.locale,
    update: {
      status: updateStatus(update, state.appVersion),
      progress: update.phase === "downloading" ? update.percent : null,
      action:
        update.phase === "disabled"
          ? null
          : {
              label: action === "restart" ? "updates.restart" : "tray.checkUpdates",
              enabled: action !== null,
              primary: action === "restart",
            },
    },
  };
}

export function quietHoursPatch(
  current: QuietHours,
  change: Partial<QuietHours>,
): QuietHours | null {
  const next = { ...current, ...change };
  if (!next.start || !next.end) return null;
  return next;
}
