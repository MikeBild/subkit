import { join } from "node:path";
import { app, Menu, type MenuItemConstructorOptions, nativeImage, Tray } from "electron";
import {
  type TrayAction,
  type TrayModel,
  trayImage,
  trayMenu,
  trayTitle,
  trayTooltip,
} from "../shared/tray-model.ts";

export type { Connection, TrayModel } from "../shared/tray-model.ts";

export type TrayActions = Record<TrayAction, () => void> & {
  dropFiles(paths: string[]): void;
};

export function trayIcon(assets: string) {
  const { file, template, size } = trayImage(process.platform);
  const image = nativeImage.createFromPath(join(assets, file));
  if (!template) return image.resize({ width: size, height: size, quality: "best" });
  image.setTemplateImage(true);
  return image;
}

export function trayTemplate(model: TrayModel, actions: TrayActions): MenuItemConstructorOptions[] {
  return trayMenu(model).map((item): MenuItemConstructorOptions => {
    if (item.kind === "separator") return { type: "separator" };
    return {
      label: item.label,
      enabled: item.enabled,
      ...(item.checked === undefined ? {} : { type: "checkbox" as const, checked: item.checked }),
      click: actions[item.action],
      ...(item.sublabel ? { sublabel: item.sublabel } : {}),
      ...(item.accelerator ? { accelerator: item.accelerator, registerAccelerator: false } : {}),
    };
  });
}

export class TrayController {
  private readonly tray: Tray;

  constructor(
    assets: string,
    private readonly actions: TrayActions,
  ) {
    this.tray = new Tray(trayIcon(assets));
    if (process.platform !== "darwin") this.tray.on("click", actions.open);
    this.tray.on("drop-files", (_event, files) => actions.dropFiles(files));
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
