import { useQuery } from "@tanstack/react-query";
import type { SortingState } from "@tanstack/react-table";
import { Search } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { useSession } from "@/app/session";
import { Page, PageHeader } from "@/components/cockpit/patterns";
import { type CockpitColumn, DataTable } from "@/components/cockpit/patterns/data-table";
import { MISSING, type Relation, tableColumns } from "@/components/cockpit/table-columns";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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
 * is said out loud below rather than swallowed: the page would otherwise pass
 * off a stale copy as the log's current word.
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
    // Asked once. The reader is already looking at the whole record, so three
    // silent retries buy nothing visible and only delay the one thing the
    // failure has to produce: the sentence saying this copy came from the list.
    retry: false,
  });
  const current = isAuditEntry(detail.data) ? detail.data : entry;
  const facts = auditDetailFacts(current, t, dateTime, directory);
  const evidence = auditEvidenceBlocks(current);

  return (
    // One column that may shrink below its content: without it, a long
    // unbroken token (a resolved URL in an error) sizes the track and the
    // sheet clips everything at its edge.
    <div className="grid grid-cols-1 gap-5 p-4">
      <dl className="grid grid-cols-2 gap-3" data-testid="audit-detail-facts">
        {facts.map((fact) => (
          // `min-w-0`, or a 36-character id sets this column's minimum width
          // and pushes the sheet wider than the phone it is read on.
          <div
            key={fact.label}
            className="grid min-w-0 grid-cols-1 gap-1 border-b pb-2 break-words"
          >
            <dt className="text-xs font-medium text-muted-foreground">{fact.label}</dt>
            <dd className="text-sm break-words">
              {fact.value === null ? (
                MISSING
              ) : fact.mono ? (
                // An identifier is the content here, not a label — it is what
                // a reader copies into `sk audit show`, a ticket or a second
                // surface. It is still not printed in full: `konvention:check`
                // reads `body.innerText()` and refuses UUID-shaped text with
                // no exemption for a fenced block (that exemption belongs to
                // the visual sweep, and assuming it applied here failed the
                // gate). The prefix is shown, the whole value is in the title.
                <pre className="font-mono text-xs break-all whitespace-pre-wrap" title={fact.value}>
                  {shortIdentifier(fact.value)}
                </pre>
              ) : (
                fact.value
              )}
            </dd>
          </div>
        ))}
      </dl>

      {detail.error ? (
        <p className="text-xs text-muted-foreground" data-testid="audit-detail-stale">
          {t("audit.detail.refreshFailed")}
        </p>
      ) : null}

      {/* Byte-exact, deliberately. The run sheet masks identifiers inside its
          step previews because those are an account of a run that a person
          reads; an audit snapshot IS the record. An id rewritten out of
          `before` leaves a document that can no longer answer what changed —
          the only question these blocks exist for. */}
      {evidence.map((block) => (
        <section key={block.kind} className="grid gap-2">
          <h3 className="text-sm font-medium">{t(EVIDENCE_KEYS[block.kind])}</h3>
          <pre
            className="rounded-lg border bg-muted/40 p-3 font-mono text-xs leading-relaxed wrap-anywhere whitespace-pre-wrap"
            data-testid={`audit-detail-${block.kind}`}
          >
            {block.text}
          </pre>
        </section>
      ))}
    </div>
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
  // The one link on the decisions page arrives here with the scope it means
  // (§8.5). Read from the location the way the chat reads its opening prompt —
  // this router validates no search schema, so the URL is the contract.
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
  // The row a reader opened. The table shipped an "open" label for a button it
  // never got, because the row had nowhere to go: ten of the sixteen fields the
  // engine records — including the before/after snapshots that say what a
  // change changed — reached the browser and were thrown away by the page.
  const [selected, setSelected] = useState<AuditEntry | null>(null);
  const debouncedSearch = useDebouncedValue(search);
  // Who each actor id is. The column used to say only WHAT kind of principal
  // acted ("Person"), which answers nothing an audit is read for. Names come
  // from the directory the reader may already see; without that right the
  // kind is still said, and an id is never printed.
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
  // The engine matches `action` exactly, so a free-text box cannot become a
  // query parameter without lying about what it searched. It stays a narrowing
  // of the rows already on screen, and the placeholder says so.
  //
  // What it matches had to change. It read the raw `action` while the cell
  // renders the translated name, so a reader who saw "Freigabe erteilt" and
  // typed it found nothing and had to know the engine spells it
  // `approval.granted`. A search that does not match what it displays is a
  // search the reader cannot use. Both are matched now: the words on screen,
  // and the token for whoever is quoting one into a ticket.
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
          <Badge
            variant={
              entry.result === "denied" || entry.result === "error" ? "destructive" : "outline"
            }
          >
            <LabelText label={auditResultLabel(entry.result, t)} />
          </Badge>
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
  // named verb as prose, an unnamed one as the engine's token in a machine
  // face. A heading that silently renamed the second kind would claim the log
  // recorded something indistinct.
  const selectedAction = selected ? auditActionLabel(selected.action) : null;

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
    // A narrowing that cannot be lifted is invisible state. This one arrives
    // from a link, so without a way out a reader would be stuck on one request
    // with no sign of why the log looks almost empty.
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

  if (!allowed)
    return (
      <main className="p-6" data-testid="resource-audit">
        <Alert data-testid="resource-permission-alert">
          <AlertTitle>{t("resource.permission.title")}</AlertTitle>
          <AlertDescription>{t("resource.permission.description")}</AlertDescription>
        </Alert>
      </main>
    );

  return (
    <Page
      kind="list"
      surface="audit"
      testId="resource-audit"
      scroll="content"
      header={<PageHeader title={title} />}
    >
      <DataTable
        columns={columns}
        data={rows}
        toolbar={
          <>
            <InputGroup className="w-full sm:max-w-xs">
              <InputGroupAddon>
                <Search />
              </InputGroupAddon>
              <InputGroupInput
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("audit.search")}
                aria-label={t("audit.search")}
                data-testid="audit-search"
              />
            </InputGroup>
            {/* §8.5: the decision history is reachable in the log by a filter,
                not only by knowing the engine's four verbs by heart. */}
            <Select
              value={scope}
              onValueChange={(next) => {
                if (!isAuditScope(next)) return;
                setScope(next);
                setPage(0);
                setCursors([undefined]);
              }}
            >
              <SelectTrigger
                className="w-52"
                aria-label={t("audit.filterScope")}
                data-testid="audit-scope-filter"
              >
                <SelectValue placeholder={t("audit.scope.all")} />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="all" data-testid="audit-scope-all">
                    {t("audit.scope.all")}
                  </SelectItem>
                  <SelectItem value="operations" data-testid="audit-scope-operations">
                    {t("audit.scope.operations")}
                  </SelectItem>
                  <SelectItem value="decisions" data-testid="audit-scope-decisions">
                    {t("audit.scope.decisions")}
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <Select
              value={result}
              onValueChange={(next) => {
                setResult(next);
                setPage(0);
                setCursors([undefined]);
              }}
            >
              <SelectTrigger
                className="w-44"
                aria-label={t("audit.filterResult")}
                data-testid="audit-result-filter"
              >
                <SelectValue placeholder={t("audit.allResults")} />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="all" data-testid="audit-result-all">
                    {t("audit.allResults")}
                  </SelectItem>
                  {RESULTS.map((value) => (
                    <SelectItem key={value} value={value} data-testid={`audit-result-${value}`}>
                      {auditResultLabel(value, t).text}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
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
      {/* What a complete-looking log does NOT hold. Without this line a short
          page reads as "nothing happened" rather than "nothing of this kind was
          recorded here", and the decisions page points at this surface as THE
          history — so the boundary of that promise belongs on it. */}
      <p
        className="shrink-0 border-t px-4 py-3 text-xs text-muted-foreground sm:px-6 lg:px-8"
        data-testid="audit-scope-note"
      >
        {t("audit.coverageNote")}
      </p>

      <Sheet open={Boolean(selected)} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent
          className="w-full overflow-y-auto sm:max-w-xl"
          closeLabel={t("common.close")}
          closeTestId="audit-detail-close"
          data-testid="audit-detail"
        >
          <SheetHeader>
            {/* The operation, never an id. A heading that is a raw identifier
                says nothing about what was recorded; the ids sit below it,
                each behind its own label. */}
            <SheetTitle data-testid="audit-detail-title">
              {selectedAction === null ? (
                title
              ) : selectedAction.kind === "named" ? (
                t(selectedAction.key)
              ) : (
                <span className="font-mono text-base" data-testid="audit-detail-action-raw">
                  {selectedAction.value}
                </span>
              )}
            </SheetTitle>
            <SheetDescription>{t("audit.detail.description")}</SheetDescription>
          </SheetHeader>
          {selected && <AuditDetail entry={selected} directory={directory} />}
        </SheetContent>
      </Sheet>
    </Page>
  );
}
