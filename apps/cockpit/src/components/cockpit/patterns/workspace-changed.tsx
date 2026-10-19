import { absolute } from "@/app/links";
import { Button } from "@/components/cockpit/patterns/controls";
import { StandaloneStatus } from "@/components/cockpit/patterns/standalone-status";
import { useI18n } from "@/lib/i18n-context";

export function WorkspaceChangedPage() {
  const { t } = useI18n();
  return (
    <StandaloneStatus
      layout="centered"
      title={t("workspace.staleTitle")}
      testId="workspace-changed"
    >
      <p>{t("workspace.staleBody")}</p>
      <Button
        data-testid="workspace-reload"
        className="mt-2"
        size="sm"
        onClick={() => window.location.replace(absolute("/"))}
      >
        {t("workspace.reload")}
      </Button>
    </StandaloneStatus>
  );
}
