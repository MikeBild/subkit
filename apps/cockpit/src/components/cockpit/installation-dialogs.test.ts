import { describe, expect, test } from "bun:test";
import { translate } from "@/lib/i18n";
import { installationDialogMode, notificationDialogState } from "./installation-dialogs";

const installation = {
  id: "11111111-1111-4111-8111-111111111111",
  start_url: "/cockpit/i/11111111-1111-4111-8111-111111111111/",
  manifest_url: "/cockpit/i/11111111-1111-4111-8111-111111111111/manifest.webmanifest",
};

describe("browser Cockpit installation entry", () => {
  test("offers the install path when the workspace has no installed app", () => {
    expect(installationDialogMode(null, null)).toEqual({ kind: "install" });
  });

  test("opens the installed app where notifications live", () => {
    expect(installationDialogMode(null, installation)).toEqual({
      kind: "open",
      href: installation.start_url,
    });
  });

  test("keeps the install prompt inside the installed app", () => {
    expect(installationDialogMode(installation.id, installation)).toEqual({ kind: "install" });
  });

  test("explains where notifications live in both languages", () => {
    for (const locale of ["en", "de"] as const) {
      expect(translate(locale, "installation.openApp")).not.toBe("installation.openApp");
      expect(translate(locale, "installation.notificationsInApp").length).toBeGreaterThan(10);
      expect(translate(locale, "installation.notificationsAfterInstall").length).toBeGreaterThan(
        10,
      );
    }
  });
});

describe("notification dialog states", () => {
  const base = {
    installed: false,
    supported: true,
    permission: "default" as NotificationPermission,
    subscribed: false as boolean | null,
    pending: false,
    handledByApp: false,
  };

  test("maps every design state to bell, switch and line", () => {
    expect(notificationDialogState({ ...base, supported: false, permission: null })).toEqual({
      bell: false,
      checked: false,
      disabled: true,
      note: "hint",
    });
    expect(notificationDialogState(base)).toEqual({
      bell: true,
      checked: false,
      disabled: false,
      note: "hint",
    });
    expect(notificationDialogState({ ...base, pending: true })).toEqual({
      bell: true,
      checked: false,
      disabled: true,
      note: "hint",
    });
    expect(notificationDialogState({ ...base, permission: "granted", subscribed: true })).toEqual({
      bell: true,
      checked: true,
      disabled: false,
      note: "hint",
    });
    expect(notificationDialogState({ ...base, permission: "granted", subscribed: false })).toEqual({
      bell: true,
      checked: false,
      disabled: false,
      note: "hint",
    });
    expect(notificationDialogState({ ...base, permission: "denied", subscribed: true })).toEqual({
      bell: true,
      checked: false,
      disabled: true,
      note: "denied",
    });
    expect(notificationDialogState({ ...base, permission: "granted", handledByApp: true })).toEqual(
      { bell: true, checked: false, disabled: true, note: "handledByApp" },
    );
    expect(notificationDialogState({ ...base, subscribed: null })).toEqual({
      bell: true,
      checked: false,
      disabled: true,
      note: "hint",
    });
  });

  test("the bell shows in the browser tab only when push is supported", () => {
    expect(notificationDialogState({ ...base, supported: true }).bell).toBeTrue();
    expect(notificationDialogState({ ...base, supported: false }).bell).toBeFalse();
    expect(notificationDialogState({ ...base, installed: true, supported: false })).toEqual({
      bell: true,
      checked: false,
      disabled: true,
      note: "hint",
    });
  });

  test("uses the agreed copy in both languages", () => {
    const copy = {
      en: {
        "installation.notifications": "Notifications",
        "installation.notificationsEnable": "Enable neutral notifications",
        "installation.notificationsHint": "Alerts contain no workspace or workflow details.",
        "installation.notificationsDenied":
          "Notifications are blocked. Allow them in your browser's site settings.",
        "installation.notificationsHandledByApp":
          "The installed app already notifies on this device.",
        "installation.notificationsInApp": "You can turn on notifications here or in the app.",
        "installation.notificationsAfterInstall":
          "Notifications also work in this browser tab via the bell.",
      },
      de: {
        "installation.notifications": "Benachrichtigungen",
        "installation.notificationsEnable": "Neutrale Benachrichtigungen aktivieren",
        "installation.notificationsHint":
          "Alerts enthalten keine Details zu Arbeitsbereichen oder Workflows.",
        "installation.notificationsDenied":
          "Benachrichtigungen sind blockiert. Erlaube sie in den Website-Einstellungen des Browsers.",
        "installation.notificationsHandledByApp":
          "Die installierte App benachrichtigt auf diesem Gerät bereits.",
        "installation.notificationsInApp":
          "Benachrichtigungen kannst du hier oder in der App aktivieren.",
        "installation.notificationsAfterInstall":
          "Benachrichtigungen funktionieren auch in diesem Browser-Tab über die Glocke.",
      },
    } as const;
    for (const locale of ["en", "de"] as const)
      for (const [key, text] of Object.entries(copy[locale]))
        expect(translate(locale, key as Parameters<typeof translate>[1])).toBe(text);
  });
});
