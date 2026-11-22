import { absolute, chatNewHref } from "@/app/links";
import { Button } from "@/components/cockpit/patterns/controls";
import type { SourceStripAction as Action } from "@/features/knowledge/model/source-detail-model";
import { useI18n } from "@/lib/i18n-context";

export function SourceStripAction({
  action,
  source,
  busy,
  onRetry,
  onActivate,
}: {
  action: Exclude<Action, null>;
  source: { id: string; name: string };
  busy: boolean;
  onRetry: () => void;
  onActivate: () => void;
}) {
  const { t } = useI18n();
  if (action === "retry")
    return (
      <Button data-testid="kn-retry" size="sm" variant="outline" onClick={onRetry}>
        {t("kn.retry")}
      </Button>
    );
  if (action === "chat")
    return (
      <Button asChild size="sm" variant="outline">
        <a
          data-testid="knowledge-error-chat"
          href={absolute(
            chatNewHref({
              prompt: t("knowledge.errorPrompt", { name: source.name }),
              references: [{ type: "knowledge_source", id: source.id }],
            }),
          )}
        >
          {t("remedy.chat")}
        </a>
      </Button>
    );
  return (
    <Button
      data-testid="kn-sources-activate"
      size="sm"
      variant="outline"
      disabled={busy}
      onClick={onActivate}
    >
      {t("kn.turnOn")}
    </Button>
  );
}
