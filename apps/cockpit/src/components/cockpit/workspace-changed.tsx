import { absolute } from "@/app/links";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n-context";

export function WorkspaceChangedPage() {
  const { t } = useI18n();
  return (
    <main className="flex min-h-svh items-start justify-center bg-background px-4 py-6 md:px-8">
      <Alert className="max-w-2xl" data-testid="workspace-changed">
        <AlertTitle>{t("workspace.staleTitle")}</AlertTitle>
        <AlertDescription>
          <p>{t("workspace.staleBody")}</p>
          <Button className="mt-2" size="sm" onClick={() => window.location.replace(absolute("/"))}>
            {t("workspace.reload")}
          </Button>
        </AlertDescription>
      </Alert>
    </main>
  );
}
