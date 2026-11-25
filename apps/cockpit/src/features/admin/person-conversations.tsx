import {
  Button,
  ConfirmDialog,
  DataState,
  Section,
  useConfirmTarget,
} from "@/components/cockpit/patterns";
import { formatDateTime } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { type PersonConversationRow, personConversationRow } from "./model/person-conversations";
import { useDeletePersonConversation, usePersonConversations } from "./use-person-conversations";

export function PersonConversations({ personId, name }: { personId: string; name: string }) {
  const { t, locale } = useI18n();
  const confirmation = useConfirmTarget<PersonConversationRow>();
  const list = usePersonConversations(personId);
  const remove = useDeletePersonConversation(() => confirmation.close());
  const labels = {
    hidden: t("chat.visibility.hiddenTitle"),
    untitled: t("chat.untitled"),
  };
  const rows = (list.data?.items ?? []).map((item) => personConversationRow(item, labels));
  const target = confirmation.target;
  return (
    <Section label={t("people.conversations")} testId="people-sheet-conversations">
      <p className="text-xs text-muted-foreground">{t("people.conversations.help")}</p>
      {list.isError ? (
        <DataState
          state="error"
          line={t("people.conversations.loadFailed")}
          onRetry={() => list.refetch()}
          testId="people-conversations-failed"
        />
      ) : list.isPending ? (
        <DataState state="loading" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="people-conversations-empty">
          {t("people.conversations.empty")}
        </p>
      ) : (
        <ul className="grid gap-1" data-testid="people-conversations">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-sm"
              data-testid={`people-conversation-${row.id}`}
            >
              <span className="grid min-w-0 flex-1">
                <span className={row.hidden ? "truncate italic" : "truncate"}>{row.title}</span>
                <span className="text-xs text-muted-foreground">
                  {t("people.conversations.updated", {
                    date: formatDateTime(locale, row.updated_at),
                  })}
                </span>
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => confirmation.ask(row)}
                aria-label={t("people.conversations.deleteLabel", { title: row.title })}
                data-testid={`people-conversation-delete-${row.id}`}
              >
                {t("chat.delete")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        {...confirmation.dialog({ locked: remove.isPending })}
        object={t("people.conversations.object", { name })}
        verb={t("chat.delete.verb")}
        consequence={
          target?.hidden
            ? t("people.conversations.consequenceHidden", {
                date: formatDateTime(locale, target.updated_at),
              })
            : t("chat.delete.consequence", { title: target?.title ?? "" })
        }
        destructive
        pending={remove.isPending}
        onConfirm={async () => {
          if (target) await remove.mutateAsync(target).catch(() => {});
        }}
        testId="people-conversation-delete-confirm"
      />
    </Section>
  );
}
