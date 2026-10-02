import { useQuery } from "@tanstack/react-query";
import { listConversationsAbout } from "@/api/client";
import { absolute, conversationHref } from "@/app/links";
import { LoadFailed, queryView } from "@/components/failure-state";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelativeTime } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";

/**
 * The conversations people had about this object. Provenance is structural
 * here, as in the reference model: you see them where the object is, and the
 * global chat list stays a way back into your own work.
 *
 * Four states, told apart (`queryView`): while it loads there is a skeleton,
 * a failed read says so and offers a retry, and a record nobody talked about
 * has no section at all — "Noch keine Unterhaltungen" used to stand for all
 * three, so a read that failed looked like a record without conversations.
 */
export function ConversationsAbout({
  target,
}: {
  target: { workflow_id?: string; connector_id?: string };
}) {
  const { t, locale } = useI18n();
  const query = useQuery({
    queryKey: ["conversations", "about", target.workflow_id, target.connector_id],
    queryFn: () => listConversationsAbout(target),
  });
  const view = queryView(query, (data) => (data.items ?? []).length === 0);
  if (view === "empty") return null;
  const items = query.data?.items ?? [];
  return (
    <section className="grid gap-2" data-testid="detail-conversations">
      <h2 className="text-sm font-semibold">{t("catalog.conversations.title")}</h2>
      {view === "loading" ? (
        <Skeleton className="h-12 w-full" />
      ) : view === "error" ? (
        <LoadFailed
          title={t("catalog.conversations.failed")}
          onRetry={() => void query.refetch()}
          testId="detail-conversations-failed"
        />
      ) : (
        <ul className="grid gap-1">
          {items.map((conversation, index) => (
            <li key={conversation.id}>
              <a
                className="flex items-baseline justify-between gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
                href={absolute(conversationHref(conversation.id))}
                aria-label={t("catalog.conversations.open")}
                data-testid={`detail-conversation-${index}`}
              >
                <span className="min-w-0 truncate">{conversation.title || t("chat.untitled")}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatRelativeTime(
                    locale,
                    conversation.last_activity_at ?? conversation.updated_at,
                  )}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
