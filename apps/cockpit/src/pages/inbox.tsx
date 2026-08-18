import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SortingState } from "@tanstack/react-table";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { useSession } from "@/app/session";
import { type CockpitColumn, DataTable } from "@/components/cockpit/data-table";
import { PageFrame } from "@/components/cockpit/page-frame";
import { type Relation, tableColumns } from "@/components/cockpit/table-columns";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { type InboxFilter, type InboxItem, inboxHref, inboxQuery } from "@/pages/inbox-model";

type InboxList = components["schemas"]["CliNotificationInboxListResponse"];

const PAGE_SIZE = 50;

const EVENT_LABEL: Record<string, TranslationKey> = {
  "execution.failed": "inbox.event.executionFailed",
  "execution.succeeded": "inbox.event.executionSucceeded",
  "execution.aborted": "inbox.event.executionAborted",
  "workflow.updated": "inbox.event.workflowUpdated",
  "patch.proposed": "inbox.event.patchProposed",
  "patch.applied": "inbox.event.patchApplied",
  "connector.auth_failed": "inbox.event.connectorAuthFailed",
  "connector.health_changed": "inbox.event.connectorHealthChanged",
  "connector.oauth.callback_failed": "inbox.event.connectorSignInFailed",
  "connector.oauth.callback_succeeded": "inbox.event.connectorSignInSucceeded",
  "apikey.rotated": "inbox.event.apiKeyRotated",
  "conversation.committed": "inbox.event.conversationCommitted",
};

const RESOURCE_LABEL: Record<string, TranslationKey> = {
  workflow: "inbox.resource.workflow",
  connector: "inbox.resource.connector",
  execution: "inbox.resource.execution",
  conversation: "inbox.resource.conversation",
  patch_candidate: "inbox.resource.patchCandidate",
  knowledge_source: "inbox.resource.knowledgeSource",
  skill: "inbox.resource.skill",
  file: "inbox.resource.file",
  api_key: "inbox.resource.apiKey",
};

/**
 * The things a person has to deal with, not a log of everything that happened.
 *
 * The page this replaces showed the raw event stream: no read state, no target,
 * and a confirm button that ran a tenant-wide delete, so one operator clearing
 * their CLI emptied everyone else's view. The engine now records per event
 * whether it needs a person and what it concerns, and marks read per user, so
 * this page can answer "what is mine to handle" and leave everyone else's copy
 * alone.
 */
export function InboxPage() {
  const { t, dateTime } = useI18n();
  const session = useSession();
  const queryClient = useQueryClient();
  const allowed = session.permissions.includes("notification:read");
  const title = t("resource.inbox.title");
  const [filter, setFilter] = useState<InboxFilter>("actionable");
  const [page, setPage] = useState(0);
  const [cursors, setCursors] = useState<(number | null)[]>([null]);

  const query = useQuery({
    queryKey: ["inbox", filter, page, cursors[page]],
    enabled: allowed,
    queryFn: () =>
      apiRequest<InboxList>(
        `/v1/notifications/inbox?${inboxQuery(filter, PAGE_SIZE, cursors[page] ?? null)}`,
      ),
  });
  const rows = useMemo(() => query.data?.items ?? [], [query.data]);

  const setRead = useMutation({
    mutationFn: (input: { ids: number[]; read: boolean }) =>
      apiRequest(`/v1/notifications/inbox/${input.read ? "read" : "unread"}`, {
        method: "POST",
        body: JSON.stringify({ ids: input.ids }),
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["inbox"] }),
    onError: () => toast.error(t("inbox.markFailed")),
  });

  const columns = useMemo<CockpitColumn<InboxItem>[]>(() => {
    const column = tableColumns<InboxItem>({ t, dateTime });
    return [
      column.custom(
        "event",
        (item) => item.event_type,
        t("inbox.column.event"),
        (item) => {
          const key = EVENT_LABEL[item.event_type];
          return (
            <span className={item.read ? "text-muted-foreground" : "font-medium"}>
              {key ? t(key) : item.event_type}
            </span>
          );
        },
        { width: "w-[30%]" },
      ),
      column.custom(
        "actionable",
        (item) => item.actionable,
        t("inbox.column.needsYou"),
        (item) =>
          item.actionable ? (
            <Badge variant="destructive">{t("inbox.needsYou")}</Badge>
          ) : (
            <span className="text-muted-foreground text-xs">{t("inbox.informational")}</span>
          ),
        { width: "w-[14%]" },
      ),
      column.status("severity", (item) => item.severity, t("inbox.column.severity"), {
        width: "w-[12%]",
      }),
      column.link(
        "resource",
        (item): Relation | null => {
          if (!item.resource_type) return null;
          const key = RESOURCE_LABEL[item.resource_type];
          return { href: inboxHref(item), label: key ? t(key) : item.resource_type };
        },
        t("inbox.column.concerns"),
        { width: "w-[16%]" },
      ),
      column.date("created_at", (item) => item.created_at, t("inbox.column.received"), {
        width: "w-[16%]",
      }),
      column.custom(
        "read",
        (item) => item.read,
        t("inbox.column.read"),
        (item, index) => (
          <Button
            variant="ghost"
            size="sm"
            data-testid={`inbox-toggle-read-${index}`}
            disabled={setRead.isPending}
            onClick={(event) => {
              event.stopPropagation();
              setRead.mutate({ ids: [item.id], read: !item.read });
            }}
          >
            {t(item.read ? "inbox.markUnread" : "inbox.markRead")}
          </Button>
        ),
        { width: "w-[12%]" },
      ),
    ];
  }, [t, dateTime, setRead]);

  const resetFilters = useCallback(() => {
    setFilter("all");
    setPage(0);
    setCursors([null]);
  }, []);

  const chooseFilter = useCallback((next: InboxFilter) => {
    setFilter(next);
    setPage(0);
    setCursors([null]);
  }, []);

  if (!allowed)
    return (
      <main className="p-6" data-testid="resource-inbox">
        <Alert data-testid="resource-permission-alert">
          <AlertTitle>{t("resource.permission.title")}</AlertTitle>
          <AlertDescription>{t("resource.permission.description")}</AlertDescription>
        </Alert>
      </main>
    );

  const unread = query.data?.unread_count ?? 0;
  const actionable = query.data?.actionable_unread_count ?? 0;
  const FILTERS: Array<{ value: InboxFilter; key: TranslationKey }> = [
    { value: "actionable", key: "inbox.filter.actionable" },
    { value: "unread", key: "inbox.filter.unread" },
    { value: "all", key: "inbox.filter.all" },
  ];

  return (
    <PageFrame
      testId="resource-inbox"
      title={title}
      description={t("resource.inbox.description")}
      scroll="content"
    >
      <DataTable
        columns={columns}
        data={rows}
        toolbar={
          <>
            {/* The counts belong beside the filters that produce them: a filter
                whose result you cannot anticipate is a button you press to find
                out what it does. */}
            {FILTERS.map((entry, index) => (
              <Button
                key={entry.value}
                variant={filter === entry.value ? "default" : "outline"}
                size="sm"
                data-testid={`inbox-filter-${index}`}
                onClick={() => chooseFilter(entry.value)}
              >
                {t(entry.key)}
              </Button>
            ))}
            <span className="text-muted-foreground text-xs sm:ml-auto" data-testid="inbox-counts">
              {t("inbox.counts", { unread: String(unread), actionable: String(actionable) })}
            </span>
          </>
        }
        onRefresh={() => void query.refetch()}
        refreshing={query.isFetching}
        refreshLabel={t("common.refresh")}
        pending={query.isPending}
        error={
          query.error
            ? {
                title: t("resource.loadFailed", { resource: title }),
                description: t("resource.loadFailedDescription"),
                retryLabel: t("session.retry"),
                onRetry: () => void query.refetch(),
              }
            : null
        }
        emptyState={{
          zero: {
            title: t("resource.inbox.empty"),
            description: t("resource.emptyDescription"),
          },
          filtered: {
            title: t("inbox.emptyFiltered"),
            description: t("inbox.emptyFilteredDescription"),
            resetLabel: t("inbox.showAll"),
            onReset: resetFilters,
          },
        }}
        hasActiveFilters={filter !== "all"}
        sorting={[] as SortingState}
        onSortingChange={() => {}}
        mode="cursor"
        page={page}
        pageSize={PAGE_SIZE}
        hasNext={rows.length === PAGE_SIZE}
        onPageChange={(next) => {
          if (next > page) {
            const cursor = query.data?.cursor;
            if (typeof cursor !== "number") return;
            setCursors((current) => {
              const copy = [...current];
              copy[next] = cursor;
              return copy;
            });
          }
          setPage(Math.max(0, next));
        }}
        previousLabel={t("catalog.previous")}
        nextLabel={t("catalog.next")}
        columnsLabel={t("catalog.columns")}
        recordsLabel={t("catalog.records")}
        loadedLabel={t("catalog.loaded", { count: rows.length })}
        actionsLabel={t("common.actions")}
        openLabel={t("common.open")}
      />
    </PageFrame>
  );
}
