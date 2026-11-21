import { Panel } from "@ui/atoms/pill";
import { SettingsRow } from "@ui/molecules/settings-row";
import { BookOpen, Bug } from "lucide-react";
import { absolute, docsHref } from "@/app/links";
import { Button } from "@/components/cockpit/patterns";
import { openFeedback } from "@/features/feedback";
import { useI18n } from "@/lib/i18n-context";

export function HelpArea() {
  const { t } = useI18n();
  return (
    <div data-testid="settings-area-help">
      <Panel className="divide-y py-1">
        <SettingsRow
          icon={BookOpen}
          label={t("settings.helpArea.docs")}
          hint={t("settings.helpArea.docsHint")}
          testId="settings-help-docs"
        >
          <Button asChild variant="outline" size="sm">
            <a href={absolute(docsHref())} data-testid="settings-help-docs-open">
              {t("settings.helpArea.docsOpen")}
            </a>
          </Button>
        </SettingsRow>
        <SettingsRow
          icon={Bug}
          label={t("feedback.entry")}
          hint={t("settings.helpArea.reportHint")}
          testId="settings-help-report"
        >
          <Button
            variant="outline"
            size="sm"
            onClick={() => openFeedback()}
            data-testid="settings-help-report-open"
          >
            {t("settings.helpArea.reportOpen")}
          </Button>
        </SettingsRow>
      </Panel>
    </div>
  );
}
