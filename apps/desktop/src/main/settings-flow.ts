import { app } from "electron";
import { type Locale, t } from "../shared/i18n.ts";
import { type DesktopSettingsView, desktopUpdateView } from "../shared/ipc.ts";
import type { OnboardingStep } from "../shared/onboarding.ts";
import { parseSettings, type Settings, type StoreData } from "../shared/profiles.ts";
import type { UpdateState } from "../shared/updates.ts";
import { launchesAtLogin, setLaunchAtLogin } from "./login-item.ts";
import { showNotification } from "./notify.ts";

export interface SettingsFlowOptions {
  data: () => StoreData;
  update: (change: (data: StoreData) => StoreData) => void;
  locale: () => Locale;
  updateState: () => UpdateState;
  completed: (step: OnboardingStep) => void;
  open: () => void;
  render: () => void;
  onError: (scope: string, error: unknown) => void;
}

export class SettingsFlow {
  constructor(private readonly options: SettingsFlowOptions) {}

  settings(): Settings {
    return this.options.data().settings;
  }

  launchAtLogin(): boolean {
    return app.isPackaged ? launchesAtLogin() : this.settings().launchAtLogin;
  }

  view(): DesktopSettingsView {
    const settings = this.settings();
    const locale = this.options.locale();
    return {
      appVersion: app.getVersion(),
      launchAtLogin: this.launchAtLogin(),
      launchAtLoginAvailable: app.isPackaged,
      shareDiagnostics: settings.shareDiagnostics,
      notifications: settings.notifications,
      update: desktopUpdateView(this.options.updateState(), app.getVersion(), (key, vars) =>
        t(locale, key, vars),
      ),
    };
  }

  change(input: Record<string, unknown>): void {
    const merged = parseSettings({ ...this.settings(), ...input });
    const launch = merged.launchAtLogin !== this.settings().launchAtLogin;
    this.patch({ ...merged, pauseUntil: this.settings().pauseUntil });
    if (launch) this.setLaunch(merged.launchAtLogin);
    else this.options.render();
  }

  setLaunch(enabled: boolean): void {
    try {
      setLaunchAtLogin(enabled);
    } catch (error) {
      this.options.onError("login-item", error);
    }
    this.patch({ launchAtLogin: enabled });
    this.options.render();
  }

  setLocale(locale: Locale): void {
    this.patch({ locale });
    this.options.render();
  }

  answerNotifications(allow: boolean): void {
    this.patch({ notifications: allow, notificationsAsked: true });
    if (allow) {
      const locale = this.options.locale();
      showNotification(
        {
          id: "notifications-on",
          title: t(locale, "perm.test.title"),
          body: t(locale, "perm.test.body"),
          silent: false,
          urgency: "normal",
          href: null,
        },
        () => this.options.open(),
      );
    }
    this.answered("notifications");
  }

  answerDiagnostics(share: boolean): void {
    this.patch({ shareDiagnostics: share, diagnosticsAsked: true });
    this.answered("diagnostics");
  }

  private answered(step: OnboardingStep): void {
    this.options.completed(step);
    this.options.render();
  }

  private patch(change: Partial<Settings>): void {
    this.options.update((data) => ({ ...data, settings: { ...data.settings, ...change } }));
  }
}
