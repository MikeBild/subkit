import { describe, expect, test } from "bun:test";
import { translate } from "@/lib/i18n";
import { installationDialogMode } from "./installation-dialogs";

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
