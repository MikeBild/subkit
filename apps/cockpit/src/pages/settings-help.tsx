import { Panel } from "@ui/components/proto/Pill";
import { BookOpen, Bug } from "lucide-react";
import { absolute, docsHref } from "@/app/links";
import { Button } from "@/components/cockpit/patterns";
import { openFeedback } from "@/features/feedback";
import { Row } from "@/features/settings";
import { useI18n } from "@/lib/i18n-context";

export function HelpArea() {
  const { t } = useI18n();
  return (
    <div data-testid="settings-area-help">
      <Panel className="divide-y py-1">
        <Row
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
        </Row>
        <Row
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
        </Row>
      </Panel>
    </div>
  );
}
