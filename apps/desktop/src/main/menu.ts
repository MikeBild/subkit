import { app, Menu, type MenuItemConstructorOptions } from "electron";
import { aboutPanel } from "../shared/app-identity.ts";
import { type Locale, t } from "../shared/i18n.ts";
import type { ProfileSummary } from "../shared/ipc.ts";
import type { MenuUpdateItem } from "../shared/tray-model.ts";

export interface MenuModel {
  locale: Locale;
  profiles: ProfileSummary[];
  update: MenuUpdateItem | null;
}

export interface MenuActions {
  settings(): void;
  addServer(): void;
  openProfile(id: string): void;
  reportProblem(): void;
  checkUpdates(): void;
  quit(): void;
}

export function applyMenu(model: MenuModel, actions: MenuActions): void {
  const { locale } = model;
  const mac = process.platform === "darwin";
  if (mac) app.setAboutPanelOptions(aboutPanel(locale, app.name, app.getVersion()));
  const settings: MenuItemConstructorOptions = {
    label: t(locale, "menu.settings"),
    accelerator: "CmdOrCtrl+,",
    click: actions.settings,
  };
  const quit: MenuItemConstructorOptions = {
    label: t(locale, "tray.quit"),
    accelerator: "CmdOrCtrl+Q",
    click: actions.quit,
  };
  const appMenu: MenuItemConstructorOptions = {
    label: app.name,
    submenu: [
      { role: "about", label: t(locale, "menu.about") },
      { type: "separator" },
      settings,
      { label: t(locale, "menu.reportProblem"), click: actions.reportProblem },
      { type: "separator" },
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      { type: "separator" },
      quit,
    ],
  };
  const servers: MenuItemConstructorOptions = {
    label: t(locale, "menu.servers"),
    submenu: [
      ...model.profiles.map(
        (profile): MenuItemConstructorOptions => ({
          label: profile.label,
          type: "radio",
          checked: profile.active,
          click: () => actions.openProfile(profile.id),
        }),
      ),
      ...(model.profiles.length > 0 ? [{ type: "separator" } as MenuItemConstructorOptions] : []),
      { label: t(locale, "menu.addServer"), accelerator: "CmdOrCtrl+N", click: actions.addServer },
      ...(mac ? [] : [{ type: "separator" } as MenuItemConstructorOptions, settings, quit]),
    ],
  };
  const view: MenuItemConstructorOptions = {
    label: t(locale, "menu.view"),
    submenu: [
      { role: "reload", label: t(locale, "menu.reload") },
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
      ...(app.isPackaged ? [] : [{ role: "toggleDevTools" } as MenuItemConstructorOptions]),
    ],
  };
  const help: MenuItemConstructorOptions = {
    role: "help",
    label: t(locale, "menu.help"),
    submenu: [
      { label: t(locale, "menu.reportProblem"), click: actions.reportProblem },
      ...(model.update
        ? [
            {
              label: model.update.label,
              enabled: model.update.enabled,
              click: actions.checkUpdates,
            },
          ]
        : []),
    ],
  };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(mac ? [appMenu] : []),
      servers,
      { role: "editMenu", label: t(locale, "menu.edit") },
      view,
      { role: "windowMenu", label: t(locale, "menu.window") },
      help,
    ]),
  );
}
