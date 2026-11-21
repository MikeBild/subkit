import { Pill } from "@ui/atoms/pill";
import { ErrorNotice } from "@ui/molecules/error-notice";
import { SettingsRow } from "@ui/molecules/settings-row";
import { BellOff } from "lucide-react";
import { Button } from "@/components/cockpit/patterns";
import { errorRows } from "@/lib/error-rows";
import { useI18n } from "@/lib/i18n-context";
import { PAUSE_OPTION_KEYS, PAUSE_OPTIONS } from "./pause-model";
import type { PauseControl } from "./use-notification-pause";

export function PauseRow({
  control,
  when,
}: {
  control: PauseControl;
  when?: "paused" | "running";
}) {
  const { t } = useI18n();
  if (!control.loaded) return null;
  if (when === "paused" && !control.label) return null;
  if (when === "running" && control.label) return null;
  return (
    <SettingsRow
      icon={BellOff}
      label={t("pause.label")}
      hint={t("pause.hint")}
      testId="settings-notification-pause"
      below={
        control.error ? (
          <ErrorNotice
            testId="settings-notification-pause-failed"
            kind="settingNotSaved"
            title={t("pause.failed")}
            body={t("pause.failedBody")}
            primary={{
              label: t("pattern.retry"),
              onClick: control.retry,
              testId: "settings-notification-pause-retry",
            }}
            rows={errorRows(control.error, t)}
          />
        ) : undefined
      }
    >
      {control.label ? (
        <div className="flex flex-wrap items-center gap-2">
          <span data-testid="settings-notification-pause-state">
            <Pill tone="info">{control.label}</Pill>
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={control.busy}
            onClick={control.resume}
            data-testid="settings-notification-pause-resume"
          >
            {t("pause.resume")}
          </Button>
        </div>
      ) : (
        <fieldset
          className="flex flex-wrap gap-2"
          aria-label={t("pause.label")}
          data-testid="settings-notification-pause-options"
        >
          {PAUSE_OPTIONS.map((option) => (
            <Button
              key={option}
              type="button"
              size="sm"
              variant="outline"
              disabled={control.busy}
              onClick={() => control.pause(option)}
              data-testid={`settings-notification-pause-${option}`}
            >
              {t(PAUSE_OPTION_KEYS[option])}
            </Button>
          ))}
        </fieldset>
      )}
    </SettingsRow>
  );
}
