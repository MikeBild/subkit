import { Panel } from "@ui/atoms/pill";
import { SettingsRow } from "@ui/molecules/settings-row";
import { Power, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Button, Switch } from "@/components/cockpit/patterns";
import { reportFailure } from "@/lib/action-failure";
import { useI18n } from "@/lib/i18n-context";
import {
  type DesktopSettings,
  type DesktopSettingsBridge,
  type DesktopSettingsPatch,
  desktopSettingsBridge,
} from "./desktop-settings-model";

export interface DesktopSettingsControl {
  settings: DesktopSettings;
  change(patch: DesktopSettingsPatch): void;
  runUpdate(): void;
}

export function useDesktopSettings(
  given?: DesktopSettingsBridge | null,
): DesktopSettingsControl | null {
  const { t } = useI18n();
  const [bridge] = useState(() => (given === undefined ? desktopSettingsBridge() : given));
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let live = true;
    void bridge.read().then((first) => {
      if (live && first) setSettings(first);
    });
    const stop = bridge.subscribe(setSettings);
    return () => {
      live = false;
      stop();
    };
  }, [bridge]);
  if (!bridge || !settings) return null;
  return {
    settings,
    change: (patch) => {
      setSettings({ ...settings, ...patch });
      bridge.change(patch).catch((error) => reportFailure(t("common.actionFailed"), error));
    },
    runUpdate: () => {
      bridge.runUpdate().catch((error) => reportFailure(t("common.actionFailed"), error));
    },
  };
}

export function LaunchAtLoginRow({ control }: { control: DesktopSettingsControl | null }) {
  const { t } = useI18n();
  const id = useId();
  if (!control?.settings.launchAtLoginAvailable) return null;
  return (
    <SettingsRow
      id={id}
      icon={Power}
      label={t("settings.desktop.launch")}
      hint={t("settings.desktop.launchHint")}
      testId="settings-desktop-launch"
    >
      <Switch
        id={id}
        checked={control.settings.launchAtLogin}
        onCheckedChange={(launchAtLogin) => control.change({ launchAtLogin })}
        data-testid="settings-desktop-launch-switch"
      />
    </SettingsRow>
  );
}

export function UpdatesPanel({ control }: { control: DesktopSettingsControl }) {
  const { t } = useI18n();
  const { update, appVersion } = control.settings;
  return (
    <div data-testid="settings-area-updates">
      <Panel className="flex flex-col gap-3">
        <p className="text-sm">
          {t("settings.desktop.version")}:{" "}
          <span className="font-mono font-semibold">{appVersion}</span>
        </p>
        <p
          role="status"
          aria-live="polite"
          className="text-sm text-muted-foreground"
          data-testid="settings-updates-line"
        >
          {update.line}
        </p>
        {update.progress !== null ? (
          <progress
            className="h-1 w-full accent-primary"
            max={100}
            value={update.progress}
            aria-label={update.line}
          />
        ) : null}
        {update.action ? (
          <Button
            className="self-start"
            variant={update.action.primary ? "default" : "outline"}
            disabled={!update.action.enabled}
            onClick={control.runUpdate}
            data-testid="settings-updates-action"
          >
            <RefreshCw data-icon="inline-start" />
            {update.action.label}
          </Button>
        ) : null}
      </Panel>
    </div>
  );
}

export function PrivacyPanel({ control }: { control: DesktopSettingsControl }) {
  const { t } = useI18n();
  const id = useId();
  return (
    <div data-testid="settings-area-privacy">
      <Panel className="divide-y py-1">
        <SettingsRow
          id={id}
          icon={ShieldCheck}
          label={t("settings.desktop.diagnostics")}
          hint={t("settings.desktop.diagnosticsHint")}
          testId="settings-desktop-diagnostics"
        >
          <Switch
            id={id}
            checked={control.settings.shareDiagnostics}
            onCheckedChange={(shareDiagnostics) => control.change({ shareDiagnostics })}
            data-testid="settings-desktop-diagnostics-switch"
          />
        </SettingsRow>
      </Panel>
    </div>
  );
}
