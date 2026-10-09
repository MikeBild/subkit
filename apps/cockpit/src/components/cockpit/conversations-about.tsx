import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { listConversationsAbout } from "@/api/client";
import { absolute, chatNewHref, conversationHref } from "@/app/links";
import { useSession } from "@/app/session";
import { Button, type CockpitColumn, CollapsibleSection } from "@/components/cockpit/patterns";
import { RecordTable } from "@/components/cockpit/record-table";
import { tableColumns } from "@/components/cockpit/table-columns";
import { formatRelativeTime } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";

interface ConversationRow {
  id: string;
  title: string;
  when: string;
}

export function ConversationsAbout({
  target,
}: {
  target: { workflow_id?: string; connector_id?: string };
}) {
  const { t, locale, dateTime } = useI18n();
  const navigate = useNavigate();
  const { permissions } = useSession();
  const query = useQuery({
    queryKey: ["conversations", "about", target.workflow_id, target.connector_id],
    queryFn: () => listConversationsAbout(target),
  });
  const rows = useMemo<ConversationRow[]>(
    () =>
      (query.data?.items ?? []).map((conversation) => ({
        id: conversation.id,
        title: conversation.title || t("chat.untitled"),
        when: formatRelativeTime(locale, conversation.last_activity_at ?? conversation.updated_at),
      })),
    [query.data, t, locale],
  );
  const columns = useMemo<CockpitColumn<ConversationRow>[]>(() => {
    const column = tableColumns<ConversationRow>({ t, dateTime });
    return [
      column.text("title", (row) => row.title, t("catalog.conversations.title"), {
        width: "w-[70%]",
      }),
      column.text("when", (row) => row.when, t("catalog.updated"), { width: "w-[30%]" }),
    ];
  }, [t, dateTime]);
  return (
    <CollapsibleSection
      label={t("catalog.conversations.title")}
      count={query.data ? rows.length : undefined}
      testId="detail-conversations"
    >
      <RecordTable
        columns={columns}
        data={rows}
        collectionId="detail-conversation"
        emptyLine={t("catalog.conversations.empty")}
        emptyAction={
          permissions.includes("conversation:write") ? (
            <Button variant="outline" asChild data-testid="detail-conversations-ask">
              <a
                href={absolute(
                  chatNewHref({ workflowId: target.workflow_id, connectorId: target.connector_id }),
                )}
              >
                {t("catalog.conversations.ask")}
              </a>
            </Button>
          ) : undefined
        }
        pending={query.isPending}
        error={
          query.error
            ? { line: t("catalog.conversations.failed"), onRetry: () => void query.refetch() }
            : null
        }
        onOpen={(row) => void navigate({ to: conversationHref(row.id) })}
        rowHref={(row) => conversationHref(row.id)}
      />
    </CollapsibleSection>
  );
}
