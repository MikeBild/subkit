import { useQuery } from "@tanstack/react-query";
import type { SortingState } from "@tanstack/react-table";
import { useCallback, useMemo, useState } from "react";
import { apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { useSession } from "@/app/session";
import {
  Button,
  type CockpitColumn,
  CodeBlock,
  CollapsibleSection,
  DataState,
  DataTable,
  type Fact,
  FactList,
  FilterBar,
  Page,
  PageHeader,
  RecordSheet,
  StatusBadge,
  SummaryLine,
} from "@/components/cockpit/patterns";
import { MISSING, type Relation, tableColumns } from "@/components/cockpit/table-columns";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { LabelText } from "@/lib/machine-label";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { windowFilterLabel } from "@/lib/window-filter";
import {
  AUDIT_LINK_KEYS,
  type AuditEvidenceKind,
  type AuditScope,
  auditActionLabel,
  auditActorName,
  auditDetailFacts,
  auditEvidenceBlocks,
  auditFilterFromUrl,
  auditLinkParams,
  auditReasonLabel,
  auditResourceHref,
  auditResourceLabel,
  auditResultFromUrl,
  auditResultLabel,
  auditScopeParams,
  canReadDirectory,
  isAuditEntry,
  isAuditScope,
  NO_AUDIT_LINK,
  shortIdentifier,
} from "@/pages/audit-model";

type AuditEntry = components["schemas"]["AuditEntry"];
type AuditList = components["schemas"]["AuditLogListResponse"];

const PAGE_SIZE = 50;
const RESULTS = ["success", "denied", "error"] as const;
const SCOPES = ["all", "operations", "decisions"] as const satisfies readonly AuditScope[];

const SCOPE_KEYS: Record<(typeof SCOPES)[number], TranslationKey> = {
  all: "audit.scope.all",
  operations: "audit.scope.operations",
  decisions: "audit.scope.decisions",
};

const EVIDENCE_KEYS: Record<AuditEvidenceKind, TranslationKey> = {
  before: "audit.detail.before",
  after: "audit.detail.after",
  metadata: "audit.detail.metadata",
};

/**
 * One record, whole.
 *
 * The row that opened this sheet already holds everything the engine records,
 * so this fetch refreshes rather than fills — and an answer that is not an
 * audit record is therefore dropped instead of substituted. A failed refresh
 * is said out loud rather than swallowed: the page would otherwise pass off a
 * stale copy as the log's current word.
 *
 * Who, when and with what result lead; the identifiers an operator quotes into
 * a ticket follow, collapsed.
 */
function AuditDetail({
  entry,
  directory,
}: {
  entry: AuditEntry;
  directory: ReadonlyMap<string, string>;
}) {
  const { t, dateTime } = useI18n();
  const detail = useQuery({
    queryKey: ["audit-entry", entry.id],
    queryFn: () => apiRequest<unknown>(`/v1/audit-log/${encodeURIComponent(entry.id)}`),
    // Asked once: the reader already sees the whole record, so silent retries
    // only delay the one sentence the failure has to produce.
    retry: false,
  });
  const current = isAuditEntry(detail.data) ? detail.data : entry;
  const facts = auditDetailFacts(current, t, dateTime, directory);
  const evidence = auditEvidenceBlocks(current);
  const toFact = (fact: (typeof facts)[number]): Fact => ({
    label: fact.label,
    value:
      fact.value === null ? (
        MISSING
      ) : fact.mono ? (
        // An identifier is the content here, yet never printed whole: the
        // prefix is shown, the whole value is in the title (`shortIdentifier`).
        <span className="font-mono text-xs break-all" title={fact.value}>
          {shortIdentifier(fact.value)}
        </span>
      ) : (
        fact.value
      ),
  });

  return (
    <>
      <FactList
        testId="audit-detail-facts"
        items={facts.filter((fact) => !fact.mono).map(toFact)}
      />

      {detail.error ? (
        <DataState
          state="error"
          line={t("audit.detail.refreshFailed")}
          onRetry={() => void detail.refetch()}
          testId="audit-detail-stale"
        />
      ) : null}

      {/* Byte-exact, deliberately: an audit snapshot IS the record. An id
          rewritten out of `before` leaves a document that can no longer answer
          what changed — the only question these blocks exist for. */}
      {evidence.map((block) => (
        <CodeBlock
          key={block.kind}
          label={t(EVIDENCE_KEYS[block.kind])}
          lang="json"
          code={block.text}
          testId={`audit-detail-${block.kind}`}
        />
      ))}

      <CollapsibleSection label={t("audit.detail.technical")} testId="audit-detail-technical">
        <FactList items={facts.filter((fact) => fact.mono).map(toFact)} />
      </CollapsibleSection>
    </>
  );
}

/**
 * The audit log is the one list the engine pages by cursor: it has no `total`
 * and no offset, only `before`. The page therefore keeps the cursor it was
 * handed for each step and never claims a count it was not given.
 */
export function AuditPage() {
  const { t, dateTime } = useI18n();
  const session = useSession();
  const allowed = session.permissions.includes("audit:read");
  const title = t("resource.audit.title");
  // A failure count arrives with `?result=error`: it opens the failures it
  // counted, and the outcome filter shows that narrowing as its own choice.
  const [result, setResult] = useState<string>(
    () => auditResultFromUrl(window.location.search) ?? "all",
  );
  // What a link narrowed the log to. A correlation key or a record arrives
  // from the surface that showed it — a run, a step, a workflow's page — and
  // is never typed from memory, so each part is a chip the reader can lift.
  const [linked, setLinked] = useState(() => auditFilterFromUrl(window.location.search));
  // Decisions by default: the page exists for what a person answered for, and
  // the engine's housekeeping arrives fast enough to bury it. A link that
  // names a record or a request means everything that happened to it, so it
  // opens on every scope unless it says otherwise.
  const [scope, setScope] = useState<AuditScope>(
    () =>
      linked.scope ??
      (linked.resourceType || linked.traceId || linked.actions.length > 0 ? "all" : "decisions"),
  );
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  // The row a reader opened: the sheet shows the fields the table leaves out,
  // including the before/after snapshots that say what a change changed.
  const [selected, setSelected] = useState<AuditEntry | null>(null);
  const debouncedSearch = useDebouncedValue(search);
  // Who each actor id is. Names come from the directory the reader may
  // already see; without that right the kind is still said, and an id is
  // never printed.
  const directoryReadable = canReadDirectory(session);
  const people = useQuery({
    queryKey: ["audit-directory", "people"],
    enabled: allowed && directoryReadable,
    queryFn: () =>
      apiRequest<{ items?: Array<{ id: string; email?: string; name?: string }> }>(
        "/v1/identity/users?limit=200",
      ),
  });
  const accounts = useQuery({
    queryKey: ["audit-directory", "system-accounts"],
    enabled: allowed && directoryReadable,
    queryFn: () =>
      apiRequest<{ items?: Array<{ id: string; name?: string }> }>("/v1/identity/system-accounts"),
  });
  const directory = useMemo(() => {
    const byId = new Map<string, string>();
    for (const item of people.data?.items ?? []) {
      const label = item.name?.trim() || item.email?.trim();
      if (label) byId.set(item.id, label);
    }
    for (const item of accounts.data?.items ?? []) {
      const label = item.name?.trim();
      if (label) byId.set(item.id, label);
    }
    return byId;
  }, [people.data, accounts.data]);

  const query = useQuery({
    queryKey: ["audit", result, scope, linked, page, cursors[page]],
    enabled: allowed,
    queryFn: () => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (result !== "all") params.set("result", result);
      // The engine filters on `action` and takes a list, so the scope is a
      // query and not a sieve over an already-paged answer.
      for (const [key, value] of Object.entries(auditScopeParams(scope))) params.set(key, value);
      // Narrowed server-side: the engine matches `trace_id`, `resource_type`
      // and `resource_id` exactly, and this is the whole point of carrying them.
      for (const [key, value] of Object.entries(auditLinkParams(linked))) params.set(key, value);
      const before = cursors[page];
      if (before) params.set("before", before);
      return apiRequest<AuditList>(`/v1/audit-log?${params}`);
    },
  });

  const items = useMemo(() => query.data?.items ?? [], [query.data]);
  // The engine matches `action` exactly, so the free-text box narrows the rows
  // already on screen — by the words displayed and by the engine's token.
  const rows = useMemo(() => {
    const needle = debouncedSearch.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((entry) => {
      if (entry.action.toLowerCase().includes(needle)) return true;
      const label = auditActionLabel(entry.action);
      return label.kind === "named" && t(label.key).toLowerCase().includes(needle);
    });
  }, [items, debouncedSearch, t]);
  const actionName = (action: string) => {
    const label = auditActionLabel(action);
    return label.kind === "named" ? t(label.key) : label.value;
  };

  const columns = useMemo<CockpitColumn<AuditEntry>[]>(() => {
    const column = tableColumns<AuditEntry>({ t, dateTime });
    return [
      column.date("ts", (entry) => entry.ts, t("audit.column.time"), {
        width: "w-[18%]",
      }),
      // The verb, named. The engine's own string stays reachable as the cell's
      // title, because that is what an operator quotes in a ticket.
      column.custom(
        "action",
        (entry) => entry.action,
        t("audit.column.operation"),
        (entry) => {
          const label = auditActionLabel(entry.action);
          return label.kind === "named" ? (
            <span title={entry.action}>{t(label.key)}</span>
          ) : (
            <span title={entry.action} className="font-mono text-xs" data-testid="audit-action-raw">
              {label.value}
            </span>
          );
        },
        { width: "w-[22%]" },
      ),
      column.link(
        "resource",
        (entry): Relation | null => ({
          href: auditResourceHref(entry.resource_type, entry.resource_id),
          label: auditResourceLabel(entry.resource_type, t).text,
        }),
        t("audit.column.resource"),
        { width: "w-[14%]" },
      ),
      column.custom(
        "result",
        (entry) => entry.result,
        t("audit.column.result"),
        (entry) => (
          <StatusBadge state={entry.result} label={auditResultLabel(entry.result, t).text} />
        ),
        { width: "w-[11%]" },
      ),
      column.custom(
        "actor",
        (entry) => entry.actor_id ?? entry.actor_type,
        t("audit.column.actor"),
        (entry) => {
          const actor = auditActorName(entry, directory, t);
          return actor ? (
            <span className="truncate" data-testid="audit-actor">
              <LabelText label={actor} />
            </span>
          ) : (
            MISSING
          );
        },
        { width: "w-[15%]" },
      ),
      column.custom(
        "reason",
        (entry) => entry.reason,
        t("audit.column.reason"),
        (entry) => {
          const reason = auditReasonLabel(entry.reason, t);
          return reason ? <LabelText label={reason} /> : MISSING;
        },
        { width: "w-[20%]" },
      ),
    ];
  }, [t, dateTime, directory]);

  // What the open record is ABOUT, in the same two shapes the cell uses: a
  // named verb as prose, an unnamed one as the engine's token in a machine face.
  const selectedAction = selected ? auditActionLabel(selected.action) : null;
  // Where the record leads: the run it names, or the record it changed.
  const selectedHref = selected
    ? auditResourceHref(selected.resource_type, selected.resource_id)
    : null;

  const hasActiveFilters =
    Boolean(debouncedSearch.trim()) ||
    result !== "all" ||
    scope !== "decisions" ||
    linked.traceId !== null ||
    linked.resourceType !== null ||
    linked.actions.length > 0 ||
    linked.tsFrom !== null ||
    linked.tsTo !== null;
  // A narrowing the reader lifted also leaves the address, or a reload brings
  // back exactly what they had taken away.
  const forgetInAddress = useCallback((keys: readonly string[]) => {
    const params = new URLSearchParams(window.location.search);
    for (const key of keys) params.delete(key);
    const rest = params.toString();
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${rest ? `?${rest}` : ""}`,
    );
  }, []);
  const lift = useCallback(
    (part: Partial<typeof linked>, keys: readonly string[]) => {
      setLinked((current) => ({ ...current, ...part }));
      forgetInAddress(keys);
      setPage(0);
      setCursors([undefined]);
    },
    [forgetInAddress],
  );
  const resetFilters = useCallback(() => {
    setSearch("");
    setResult("all");
    setScope("decisions");
    // A narrowing that arrives from a link must be liftable, or a reader is
    // stuck on one request with no sign of why the log looks almost empty.
    setLinked(NO_AUDIT_LINK);
    forgetInAddress([
      ...AUDIT_LINK_KEYS.resource,
      ...AUDIT_LINK_KEYS.trace,
      ...AUDIT_LINK_KEYS.actions,
      ...AUDIT_LINK_KEYS.window,
      "scope",
    ]);
    setPage(0);
    setCursors([undefined]);
  }, [forgetInAddress]);

  const header = <PageHeader title={title} />;

  if (!allowed)
    return (
      <Page kind="list" surface="audit" testId="resource-audit" scroll="page" header={header}>
        <DataState
          state="empty"
          line={t("resource.permission.description")}
          testId="resource-permission-alert"
        />
      </Page>
    );

  return (
    <Page kind="list" surface="audit" testId="resource-audit" scroll="content" header={header}>
      {/* What a complete-looking log does NOT hold: without it a short page
          reads as "nothing happened" rather than "nothing of this kind was
          recorded here". */}
      <div className="shrink-0 pb-3">
        <SummaryLine
          testId="audit-summary"
          text={<span data-testid="audit-scope-note">{t("audit.summary")}</span>}
          help={t("audit.coverageNote")}
        />
      </div>
      <DataTable
        columns={columns}
        data={rows}
        toolbar={
          <>
            <FilterBar
              search={{
                value: search,
                onChange: setSearch,
                placeholder: t("audit.search"),
                testId: "audit-search",
              }}
              selects={[
                // §8.5: the decision history is reachable by a filter, not
                // only by knowing the engine's verbs by heart.
                {
                  value: scope,
                  label: t("audit.filterScope"),
                  testId: "audit-scope-filter",
                  onChange: (next) => {
                    if (!isAuditScope(next)) return;
                    setScope(next);
                    setPage(0);
                    setCursors([undefined]);
                  },
                  options: SCOPES.map((value) => ({ value, label: t(SCOPE_KEYS[value]) })),
                },
                {
                  value: result,
                  label: t("audit.filterResult"),
                  testId: "audit-result-filter",
                  onChange: (next) => {
                    setResult(next);
                    setPage(0);
                    setCursors([undefined]);
                  },
                  options: [
                    { value: "all", label: t("audit.allResults") },
                    ...RESULTS.map((value) => ({
                      value,
                      label: auditResultLabel(value, t).text,
                    })),
                  ],
                },
              ]}
            />
            {/* The narrowing a link brought, said out loud and removable. */}
            {linked.resourceType ? (
              <Button
                variant="secondary"
                size="sm"
                data-testid="audit-resource-filter"
                onClick={() =>
                  lift({ resourceType: null, resourceId: null }, AUDIT_LINK_KEYS.resource)
                }
              >
                {t(linked.resourceId ? "audit.recordFilter" : "audit.resourceFilter", {
                  resource: auditResourceLabel(linked.resourceType, t).text,
                })}
              </Button>
            ) : null}
            {linked.traceId ? (
              <Button
                variant="secondary"
                size="sm"
                data-testid="audit-trace-filter"
                onClick={() => lift({ traceId: null }, AUDIT_LINK_KEYS.trace)}
                title={linked.traceId}
              >
                {t("audit.traceFilter")}
              </Button>
            ) : null}
            {linked.actions.length > 0 ? (
              <Button
                variant="secondary"
                size="sm"
                data-testid="audit-action-filter"
                onClick={() => lift({ actions: [] }, AUDIT_LINK_KEYS.actions)}
                title={linked.actions.map((action) => actionName(action)).join(", ")}
              >
                {linked.actions.length === 1
                  ? t("audit.actionFilterOne", { action: actionName(linked.actions[0] ?? "") })
                  : t("audit.actionFilter", { count: String(linked.actions.length) })}
              </Button>
            ) : null}
            {linked.tsFrom || linked.tsTo ? (
              <Button
                variant="secondary"
                size="sm"
                data-testid="audit-window-filter"
                onClick={() => lift({ tsFrom: null, tsTo: null }, AUDIT_LINK_KEYS.window)}
              >
                {windowFilterLabel(linked.tsFrom, linked.tsTo, t, dateTime)}
              </Button>
            ) : null}
            {hasActiveFilters && (
              <Button
                variant="ghost"
                size="sm"
                data-testid="audit-clear-filters"
                onClick={resetFilters}
              >
                {t("catalog.clearFilters")}
              </Button>
            )}
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
            title: t("resource.audit.empty"),
          },
          filtered: {
            title: t("resource.noMatches"),
            description: t("resource.broaderSearch"),
            resetLabel: t("catalog.clearFilters"),
            onReset: resetFilters,
          },
        }}
        hasActiveFilters={hasActiveFilters}
        sorting={[] as SortingState}
        onSortingChange={() => {}}
        onOpen={(entry) => setSelected(entry)}
        rowLabel={(entry) =>
          t("audit.openEntry", {
            action: actionName(entry.action),
            resource: auditResourceLabel(entry.resource_type, t).text,
            time: dateTime(entry.ts),
          })
        }
        mode="cursor"
        page={page}
        pageSize={PAGE_SIZE}
        hasNext={Boolean(query.data?.next_cursor)}
        onPageChange={(next) => {
          if (next > page) {
            const cursor = query.data?.next_cursor;
            if (!cursor) return;
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
      />

      <RecordSheet
        open={Boolean(selected)}
        onOpenChange={(open) => !open && setSelected(null)}
        testId="audit-detail"
        closeTestId="audit-detail-close"
        titleTestId="audit-detail-title"
        // The operation, never an id: the ids sit below it, each labelled.
        title={
          selectedAction === null ? (
            title
          ) : selectedAction.kind === "named" ? (
            t(selectedAction.key)
          ) : (
            <span className="font-mono text-base" data-testid="audit-detail-action-raw">
              {selectedAction.value}
            </span>
          )
        }
        badge={
          selected ? (
            <StatusBadge
              state={selected.result}
              label={auditResultLabel(selected.result, t).text}
            />
          ) : null
        }
        action={
          selected && selectedHref ? (
            <Button variant="outline" asChild>
              <a href={selectedHref} data-testid="audit-detail-open">
                {selected.resource_type === "execution"
                  ? t("audit.detail.openRun")
                  : t("audit.detail.openRecord", {
                      resource: auditResourceLabel(selected.resource_type, t).text,
                    })}
              </a>
            </Button>
          ) : null
        }
      >
        {selected ? <AuditDetail entry={selected} directory={directory} /> : null}
      </RecordSheet>
    </Page>
  );
}
