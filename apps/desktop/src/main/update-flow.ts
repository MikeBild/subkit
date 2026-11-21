import { dialog } from "electron";
import { type Locale, t } from "../shared/i18n.ts";
import {
  type StatusNotification,
  updateNotice,
  updateNotification,
} from "../shared/status-model.ts";
import type { MenuUpdateItem } from "../shared/tray-model.ts";
import { type UpdateState, updateAction, updateMenuLabel } from "../shared/updates.ts";
import { UpdateController } from "./updates.ts";

export interface UpdateHost {
  locale(): Locale;
  announce(notification: StatusNotification): void;
  render(): void;
  showSettings(): void;
  confirmRestart(): Promise<boolean>;
  beforeQuit(): void;
  cancelQuit(): void;
  onError(scope: string, error: unknown): void;
}

export class UpdateFlow {
  private readonly controller: UpdateController;
  private offered: string | null = null;
  private last: UpdateState = { phase: "idle" };

  constructor(private readonly host: UpdateHost) {
    this.controller = new UpdateController({
      onState: (state) => this.onState(state),
      onError: (scope, error) => host.onError(scope, error),
    });
  }

  get current(): UpdateState {
    return this.controller.current;
  }

  start(): Promise<void> {
    return this.controller.start();
  }

  menuItem(locale: Locale): MenuUpdateItem | null {
    const state = this.controller.current;
    if (state.phase === "disabled") return null;
    const { key, vars } = updateMenuLabel(state);
    return { label: t(locale, key, vars), enabled: updateAction(state) !== null };
  }

  async check(): Promise<void> {
    const action = updateAction(this.controller.current);
    if (action === "restart") {
      this.restart();
      return;
    }
    this.host.showSettings();
    if (action === "check") await this.controller.check();
  }

  async runAction(): Promise<void> {
    const action = updateAction(this.controller.current);
    if (action === "restart") this.restart();
    else if (action === "check") await this.controller.check();
  }

  private onState(state: UpdateState): void {
    const version = updateNotice(this.last, state);
    this.last = state;
    if (version) this.host.announce(updateNotification(version, this.host.locale()));
    this.host.render();
    if (state.phase !== "ready" || this.offered === state.version) return;
    this.offered = state.version;
    void this.offerRestart(state.version);
  }

  private restart(): void {
    void this.host.confirmRestart().then((go) => {
      if (!go) return;
      this.host.beforeQuit();
      if (!this.controller.restart()) this.host.cancelQuit();
    });
  }

  private async offerRestart(version: string): Promise<void> {
    const locale = this.host.locale();
    const choice = await dialog.showMessageBox({
      type: "info",
      message: t(locale, "updates.ready.title"),
      detail: t(locale, "updates.ready.body", { version }),
      buttons: [t(locale, "updates.restart"), t(locale, "updates.later")],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice.response === 0) this.restart();
  }
}
