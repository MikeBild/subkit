import { SettingsRow } from "@ui/molecules/settings-row";
import { PanelLeftClose, PanelRightOpen } from "lucide-react";
import { useId, useState } from "react";
import { Switch } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import { readStartLayout, type StartLayout, writeStartLayout } from "@/lib/start-layout";

export function StartLayoutRows() {
  const { t } = useI18n();
  const id = useId();
  const [layout, setLayout] = useState<StartLayout>(readStartLayout);
  const change = (patch: Partial<StartLayout>) => {
    const next = { ...layout, ...patch };
    setLayout(next);
    writeStartLayout(next);
  };
  return (
    <>
      <div className="py-3" data-testid="settings-start-layout">
        <p className="text-sm font-semibold">{t("settings.startLayout.title")}</p>
      </div>
      <SettingsRow
        id={`${id}-left`}
        icon={PanelLeftClose}
        label={t("settings.startLayout.left")}
        hint={t("settings.startLayout.leftHint")}
        testId="settings-start-left"
      >
        <Switch
          id={`${id}-left`}
          checked={layout.leftCollapsed}
          onCheckedChange={(leftCollapsed) => change({ leftCollapsed })}
          data-testid="settings-start-left-switch"
        />
      </SettingsRow>
      <SettingsRow
        id={`${id}-right`}
        icon={PanelRightOpen}
        label={t("settings.startLayout.right")}
        hint={t("settings.startLayout.rightHint")}
        testId="settings-start-right"
      >
        <Switch
          id={`${id}-right`}
          checked={layout.rightOpen === true}
          onCheckedChange={(open) => change({ rightOpen: open ? true : null })}
          data-testid="settings-start-right-switch"
        />
      </SettingsRow>
    </>
  );
}
