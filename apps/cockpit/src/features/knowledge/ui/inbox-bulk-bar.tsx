import { FolderInput, Sparkles, Trash2, XCircle } from "lucide-react";
import { Button } from "@/components/cockpit/patterns/controls";
import { useI18n } from "@/lib/i18n-context";
import { type BulkAction, bulkActions } from "../model/inbox-bulk";
import type { EntryView } from "../model/knowledge";

export function InboxBulkBar({
  chosen,
  pending,
  onClear,
  onAction,
}: {
  chosen: readonly EntryView[];
  pending: boolean;
  onClear(): void;
  onAction(action: BulkAction): void;
}) {
  const { t } = useI18n();
  if (chosen.length === 0) return null;
  const actions = new Set(bulkActions(chosen));
  return (
    <section
      aria-label={t("kn.skills.cand.selection")}
      data-testid="kn-inbox-bulk"
      className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm"
    >
      <span className="mr-auto">{t("kn.skills.cand.chosen", { n: chosen.length })}</span>
      <Button data-testid="kn-inbox-bulk-clear" size="sm" variant="ghost" onClick={onClear}>
        {t("intake.clearDeletionSelection")}
      </Button>
      {actions.has("propose") && (
        <Button
          data-testid="kn-inbox-bulk-propose"
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => onAction("propose")}
        >
          <Sparkles className="size-4" aria-hidden />
          {t("intake.bulk.propose")}
        </Button>
      )}
      {actions.has("move") && (
        <Button
          data-testid="kn-inbox-bulk-move"
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => onAction("move")}
        >
          <FolderInput className="size-4" aria-hidden />
          {t("intake.bulk.move")}
        </Button>
      )}
      {actions.has("discard") && (
        <Button
          data-testid="kn-inbox-bulk-discard"
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => onAction("discard")}
        >
          <XCircle className="size-4" aria-hidden />
          {t("intake.discard")}
        </Button>
      )}
      {actions.has("remove") && (
        <Button
          data-testid="kn-inbox-bulk-delete"
          size="sm"
          variant="outline"
          className="text-destructive-ink"
          disabled={pending}
          onClick={() => onAction("remove")}
        >
          <Trash2 className="size-4" aria-hidden />
          {t("intake.deleteSelected", { count: chosen.length })}
        </Button>
      )}
    </section>
  );
}
