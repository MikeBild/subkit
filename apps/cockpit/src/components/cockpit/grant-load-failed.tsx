import { DataState } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";

export function GrantLoadFailed({ onRetry }: { onRetry(): void }) {
  const { t } = useI18n();
  return (
    <DataState
      state="error"
      line={t("authority.prepareFailed")}
      onRetry={onRetry}
      testId="authority-load-failed"
      className="py-0"
    />
  );
}
