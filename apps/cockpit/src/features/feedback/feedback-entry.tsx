import { Bug } from "lucide-react";
import { Button } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";
import { openFeedback } from "./store";

export function FeedbackButton({ className }: { className?: string }) {
  const { t } = useI18n();
  return (
    <Button
      type="button"
      variant="ghost"
      className={cn("max-[479px]:w-10 max-[479px]:px-0", className)}
      onClick={() => openFeedback()}
      data-testid="feedback-open"
    >
      <Bug aria-hidden="true" />
      <span className="max-[479px]:sr-only">{t("feedback.entry")}</span>
    </Button>
  );
}
