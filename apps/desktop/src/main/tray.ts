import { join } from "node:path";
import { app, Menu, type MenuItemConstructorOptions, nativeImage, Tray } from "electron";
import { t } from "../shared/i18n.ts";
import {
  type TrayModel,
  trayImage,
  trayStatus,
  trayTitle,
  trayTooltip,
} from "../shared/tray-model.ts";

export type { Connection, TrayModel } from "../shared/tray-model.ts";

export interface TrayActions {
  open(): void;
  openAttention(): void;
  togglePause(): void;
  toggleLaunchAtLogin(): void;
  reportProblem(): void;
  checkUpdates(): void;
  quit(): void;
}

export function trayIcon(assets: string) {
  const { file, template, size } = trayImage(process.platform);
  const image = nativeImage.createFromPath(join(assets, file));
  if (!template) return image.resize({ width: size, height: size, quality: "best" });
  image.setTemplateImage(true);
  return image;
}

export function trayTemplate(model: TrayModel, actions: TrayActions): MenuItemConstructorOptions[] {
  const { locale } = model;
  const template: MenuItemConstructorOptions[] = [
    { label: t(locale, "tray.open"), click: actions.open },
    { label: trayStatus(model), click: actions.openAttention },
    { type: "separator" },
    {
      label: t(locale, model.paused ? "tray.resume" : "tray.pause"),
      click: actions.togglePause,
    },
    {
      label: t(locale, "tray.launchAtLogin"),
      type: "checkbox",
      checked: model.launchAtLogin,
      enabled: app.isPackaged,
      click: actions.toggleLaunchAtLogin,
    },
  ];
  if (model.update)
    template.push({
      label: model.update.label,
      enabled: model.update.enabled,
      click: actions.checkUpdates,
    });
  template.push(
    { type: "separator" },
    { label: t(locale, "menu.reportProblem"), click: actions.reportProblem },
    { type: "separator" },
    { label: t(locale, "tray.quit"), click: actions.quit },
  );
  return template;
}

export class TrayController {
  private readonly tray: Tray;

  constructor(
    assets: string,
    private readonly actions: TrayActions,
  ) {
    this.tray = new Tray(trayIcon(assets));
    if (process.platform !== "darwin") this.tray.on("click", actions.open);
  }

  render(model: TrayModel): void {
    this.tray.setContextMenu(Menu.buildFromTemplate(trayTemplate(model, this.actions)));
    this.tray.setToolTip(trayTooltip(app.name, model));
    if (process.platform === "darwin") this.tray.setTitle(trayTitle(model));
  }

  destroy(): void {
    this.tray.destroy();
  }
}
