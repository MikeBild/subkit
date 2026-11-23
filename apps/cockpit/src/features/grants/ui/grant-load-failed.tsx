import { DataState } from "@/components/cockpit/patterns";
import { preparationFailureLine } from "@/features/grants/model/preparation-failure";
import { useI18n } from "@/lib/i18n-context";

export function GrantLoadFailed({ onRetry, error }: { onRetry(): void; error?: unknown }) {
  const { t } = useI18n();
  const detail = preparationFailureLine(error, t);
  return (
    <DataState
      state="error"
      line={t("authority.prepareFailed")}
      onRetry={onRetry}
      error={error}
      {...(detail ? { body: detail } : {})}
      testId="authority-load-failed"
      className="py-0"
    />
  );
}
