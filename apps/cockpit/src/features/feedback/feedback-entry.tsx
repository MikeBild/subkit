import { Bug } from "lucide-react";
import { IconButton } from "@/components/cockpit/icon-button";
import { Button } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import { openFeedback } from "./store";

export function FeedbackButton({
  className,
  labelClassName = "max-[479px]:sr-only",
}: {
  className?: string;
  labelClassName?: string;
}) {
  const { t } = useI18n();
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={className}
      onClick={() => openFeedback()}
      data-testid="feedback-open"
    >
      <Bug aria-hidden="true" />
      <span className={labelClassName}>{t("feedback.entry")}</span>
    </Button>
  );
}

export function FeedbackIconButton({ className }: { className?: string }) {
  const { t } = useI18n();
  return (
    <IconButton
      type="button"
      label={t("feedback.entry")}
      className={className}
      onClick={() => openFeedback()}
      data-testid="feedback-open-icon"
    >
      <Bug />
    </IconButton>
  );
}
