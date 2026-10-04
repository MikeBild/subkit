import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { effectKey } from "@/lib/authority-calls";
import { presentRequestBoundary } from "@/lib/authority-request";
import { presentStorageScope } from "@/lib/authority-storage";
import { useI18n } from "@/lib/i18n-context";
import type { WorkflowAuthorityPreview } from "@/lib/workflow-authorities";

export function BoundaryPanels({
  effects,
}: {
  effects: WorkflowAuthorityPreview["manifest"]["effects"];
}) {
  const { t, locale } = useI18n();
  return (
    <>
      {effects
        .flatMap((effect) => (effect.storage ? [[effect, effect.storage] as const] : []))
        .map(([effect, scope]) => {
          const shown = presentStorageScope(scope, (value) =>
            new Intl.NumberFormat(locale).format(value),
          );
          return (
            <Alert
              key={effectKey(effect.call_path, effect.step_id)}
              data-testid={
                shown.destructive
                  ? "authority-storage-boundary-destructive"
                  : "authority-storage-boundary"
              }
              variant={shown.destructive ? "destructive" : "default"}
              className={shown.destructive ? undefined : "bg-accent/10"}
            >
              <AlertTitle>{t(shown.title)}</AlertTitle>
              <AlertDescription>
                <p>{t("authority.storage.folder", { folder: scope.key_prefix })}</p>
                <p className="break-all">{scope.base_url}</p>
                <p>{t(shown.detail, shown.values)}</p>
              </AlertDescription>
            </Alert>
          );
        })}
      {effects
        .flatMap((effect) => (effect.boundary ? [[effect, effect.boundary] as const] : []))
        .map(([effect, boundary]) => {
          const shown = presentRequestBoundary(boundary, (value) =>
            new Intl.NumberFormat(locale).format(value),
          );
          return (
            <Alert
              key={effectKey(effect.call_path, effect.step_id)}
              data-testid={
                shown.destructive
                  ? "authority-request-boundary-destructive"
                  : "authority-request-boundary"
              }
              variant={shown.destructive ? "destructive" : "default"}
              className={shown.destructive ? undefined : "bg-accent/10"}
            >
              <AlertTitle>{t(shown.title)}</AlertTitle>
              <AlertDescription>
                <p className="break-all">
                  {t("authority.boundary.target", {
                    method: boundary.method,
                    target: shown.target,
                  })}
                </p>
                {shown.variables.map((variable) => (
                  <p key={variable.values.name}>{t(variable.key, variable.values)}</p>
                ))}
                {shown.classNotice && <p>{t("authority.boundary.classNotice")}</p>}
                {shown.declaredDestructive && <p>{t("authority.boundary.declaredDestructive")}</p>}
                <p>{t(shown.body.key, shown.body.values)}</p>
                <p>{t("authority.boundary.calls", { count: shown.calls })}</p>
                {shown.paging && <p>{t(shown.paging.key, shown.paging.values)}</p>}
                <p>{t("authority.boundary.contentNotice")}</p>
              </AlertDescription>
            </Alert>
          );
        })}
    </>
  );
}
