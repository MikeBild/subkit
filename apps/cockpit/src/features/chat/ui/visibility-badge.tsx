import { StatusBadge } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import type { ConversationVisibility } from "../model/visibility";

export function VisibilityBadge({
  visibility,
  testId = "chat-visibility",
}: {
  visibility: ConversationVisibility;
  testId?: string;
}) {
  const { t } = useI18n();
  return (
    <StatusBadge
      state={visibility === "team" ? "ok" : "neutral"}
      label={t(visibility === "team" ? "chat.visibility.team" : "chat.visibility.private")}
      testId={testId}
    />
  );
}
