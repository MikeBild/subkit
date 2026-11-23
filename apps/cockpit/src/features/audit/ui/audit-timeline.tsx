import { useQuery } from "@tanstack/react-query";
import { Pill } from "@ui/atoms/pill";
import { TechDetail } from "@ui/molecules/error-notice";
import { CalendarDays, ExternalLink, Filter, Search } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { apiCall } from "@/api/call";
import { ApiError } from "@/api/client";
import { useLiveQueryOptions, useLiveStatus } from "@/app/live-events";
import { useSession } from "@/app/session";
import {
  Button,
  DataState,
  FactList,
  FilterSheet,
  Page,
  RecordSheet,
  SectionHeading,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  StatusBadge,
  TopPageHeader,
} from "@/components/cockpit/patterns";
import { ForbiddenState } from "@/components/failure-state";
import { API_KEYS_QUERY } from "@/features/admin";
import {
  actorTypeLabel,
  auditActionLabel,
  auditReasonLabel,
  auditResourceHref,
  auditResourceLabel,
  auditResourcePermission,
  auditResultLabel,
  auditScopeParams,
  canReadDirectory,
  isAuditEntry,
  normalizedAuditScope,
} from "@/features/audit/model/audit-entries";
import type { Locale, TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { type ListParams, useInfiniteList } from "@/lib/use-infinite-list";
import {
  auditFilterFromSearch,
  EMPTY,
  type FilterState,
  validUrlUuid,
} from "../model/audit-filter-state";
import { accessLabel, sourceLabel } from "../model/audit-labels";
import { auditKind, auditTone } from "../model/audit-model";
import { auditTaskFacts } from "../model/audit-task";
import {
  AUDIT_GROUPS,
  type AuditGroup,
  type AuditNameBook,
  auditAccessSubject,
  auditActorDisplay,
  auditExecutionSubject,
  auditIdentityOptions,
  auditInitiatingSource,
  auditNameBook,
  auditObjectDisplay,
  auditRecordedAccess,
  groupLoadedAudit,
  type IdentityOption,
  localTimeZone,
  type TimelineEntry,
  utcFromLocalInputPreservingInstant,
  validAuditCorrelationId,
} from "../model/audit-timeline-model";
import { FilterForm, FocusFields } from "./audit-filter-form";

const GROUP_KEYS: Record<AuditGroup, TranslationKey> = {
  day: "audit.timeline.day",
  actor: "audit.timeline.actor",
  access: "audit.timeline.access",
  resourceType: "audit.timeline.resourceType",
  resource: "audit.timeline.resource",
  source: "audit.timeline.source",
  executed: "audit.timeline.executed",
  execution: "audit.timeline.execution",
  operation: "audit.timeline.operation",
  result: "audit.timeline.result",
};
function fromUrl(): FilterState {
  return auditFilterFromSearch(
    typeof window === "undefined" ? "" : window.location.search,
    Date.now(),
    localTimeZone(),
  );
}
function actionLabel(action: string, t: ReturnType<typeof useI18n>["t"]): string {
  const label = auditActionLabel(action);
  return label.kind === "named" ? t(label.key) : t("audit.action.other");
}
function changeFieldLabel(field: string, t: ReturnType<typeof useI18n>["t"]): string {
  if (field === "name" || field === "display_name" || field === "title")
    return t("audit.meta.name");
  if (field === "status") return t("audit.meta.status");
  if (field === "enabled") return t("audit.timeline.enabledField");
  if (field === "filename") return t("audit.timeline.fileNameField");
  return t("audit.timeline.otherField");
}
export function changedFieldsDescription(
  fields: readonly string[],
  t: ReturnType<typeof useI18n>["t"],
): string {
  return fields.map((field) => `${changeFieldLabel(field, t)} (${field})`).join(", ");
}
export function auditChangeValue(
  field: string,
  value: string | number | boolean | null,
  resourceType: string,
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (value === null) return t("audit.timeline.emptyValue");
  if (field === "status" && resourceType === "knowledge_source" && typeof value === "string") {
    const statuses: Record<string, TranslationKey> = {
      active: "audit.timeline.knowledgeStatus.active",
      inactive: "audit.timeline.knowledgeStatus.inactive",
      processing: "audit.timeline.knowledgeStatus.processing",
      error: "audit.timeline.knowledgeStatus.error",
    };
    const key = statuses[value];
    if (key) return `${t(key)} (${value})`;
  }
  return String(value);
}
export function unverifiedApiKeyClient(entry: TimelineEntry): boolean {
  return (
    (entry.access_type === "api_key" || Boolean(entry.api_key_id)) &&
    entry.credential_origin !== "cli_oauth_session" &&
    auditInitiatingSource(entry) === "api"
  );
}
function actorName(
  entry: Pick<TimelineEntry, "actor_type" | "actor_id">,
  identities: readonly IdentityOption[],
  t: ReturnType<typeof useI18n>["t"],
): string {
  return auditActorDisplay(
    entry,
    identities,
    (kind) => actorTypeLabel(kind, t).text,
    t("audit.timeline.notRecorded"),
  );
}
function objectName(
  entry: Pick<TimelineEntry, "resource_type" | "resource_name">,
  t: ReturnType<typeof useI18n>["t"],
): string {
  const name = auditObjectDisplay(entry, (type) => auditResourceLabel(type, t).text);
  return entry.resource_name?.trim()
    ? `${name} · ${auditResourceLabel(entry.resource_type, t).text}`
    : name;
}
function TimelineSkeleton() {
  const { t } = useI18n();
  return (
    <div
      className="relative ml-14 border-l-2 border-border pl-7"
      data-testid="audit-timeline-skeleton"
      aria-busy="true"
    >
      <span className="sr-only">{t("platform.inProgress")}</span>
      <Skeleton className="mb-7 h-4 w-44" />
      {[0, 1, 2].map((index) => (
        <div key={index} className="relative mb-6 rounded-lg border p-4">
          <span className="absolute -left-[39px] top-6 size-4 rounded-full border-4 border-background bg-border" />
          <Skeleton className="mb-3 h-3 w-20" />
          <Skeleton className="mb-3 h-4 w-2/3" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}
interface GroupNames {
  identities: readonly IdentityOption[];
  book: AuditNameBook;
  time(at: string): string;
}
function groupLabel(
  key: string,
  group: AuditGroup,
  entry: TimelineEntry,
  zone: string,
  locale: Locale,
  names: GroupNames,
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (group === "day")
    return new Intl.DateTimeFormat(locale === "de" ? "de-DE" : "en-US", {
      dateStyle: "full",
      timeZone: zone,
    }).format(new Date(entry.ts));
  if (group === "actor") return actorName(entry, names.identities, t);
  if (group === "access") {
    const subject = auditAccessSubject(entry, names.book, actorName(entry, names.identities, t));
    if (entry.api_key_id) {
      const access =
        entry.credential_origin === "cli_oauth_session"
          ? t("audit.timeline.credentialOrigin.cliOAuthSession")
          : accessLabel(entry.access_type || "api_key", t);
      return `${access} · ${subject}`;
    }
    if (entry.session_id)
      return `${accessLabel(entry.access_type || "browser_session", t)} · ${subject} · ${names.time(entry.ts)}`;
    if (entry.oauth_client_id)
      return `${accessLabel(entry.access_type || "mcp_oauth", t)} · ${subject}`;
    return accessLabel(entry.access_type, t);
  }
  if (group === "resourceType") return auditResourceLabel(entry.resource_type, t).text;
  if (group === "resource") return objectName(entry, t);
  if (group === "source") return sourceLabel(key === "unknown" ? null : key, t);
  if (group === "executed") return sourceLabel(key === "unknown" ? null : key, t);
  if (group === "result") return auditResultLabel(key, t).text;
  if (key === "unknown") return t("audit.timeline.notRecorded");
  if (group === "execution")
    return `${auditExecutionSubject(entry, names.book) ?? t("au.kind.run")} · ${names.time(entry.ts)}`;
  return `${actionLabel(entry.action, t)} · ${names.time(entry.ts)}`;
}
function EventCard({
  entry,
  selected,
  open,
  zone,
  identities,
}: {
  entry: TimelineEntry;
  selected: boolean;
  open(): void;
  zone: string;
  identities: readonly IdentityOption[];
}) {
  const { t, dateTime, locale } = useI18n();
  const actor = actorName(entry, identities, t);
  const label = actionLabel(entry.action, t);
  const local = new Intl.DateTimeFormat(locale === "de" ? "de-DE" : "en-US", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(entry.ts));
  return (
    <div className="relative mb-5 pl-6 sm:pl-8" data-testid="audit-timeline-event">
      <button
        type="button"
        data-testid="audit-timeline-entry-open"
        onClick={open}
        aria-label={t("audit.openEntry", {
          action: label,
          resource: auditResourceLabel(entry.resource_type, t).text,
          time: dateTime(entry.ts),
        })}
        aria-current={selected ? "true" : undefined}
        className={`relative w-full rounded-lg border bg-card p-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected ? "border-foreground/40" : "border-border"}`}
      >
        <span
          aria-hidden
          className={`absolute -left-[35px] top-5 size-4 rounded-full border-[3px] border-background ${entry.result === "denied" || entry.result === "error" ? "bg-destructive" : "bg-success"}`}
        />
        <time
          dateTime={entry.ts}
          className="absolute -left-[78px] top-5 w-10 whitespace-nowrap text-right text-[11px] font-medium tabular-nums text-muted-foreground sm:-left-[84px] sm:w-12"
        >
          {local}
        </time>
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={auditTone(entry)}>{t(`au.kind.${auditKind(entry)}`)}</Pill>
          <span className="text-xs text-muted-foreground">{t("au.by", { name: actor })}</span>
          <span className="ml-auto">
            <StatusBadge state={entry.result} label={auditResultLabel(entry.result, t).text} />
          </span>
        </div>
        <div className="mt-2 text-sm font-semibold">{label}</div>
        <div className="mt-1 text-sm text-muted-foreground">{objectName(entry, t)}</div>
        <div className="mt-3 grid gap-x-4 gap-y-1 border-t pt-3 text-xs sm:grid-cols-2">
          <div>
            <span className="text-muted-foreground">{t("audit.timeline.initiated")}: </span>
            {sourceLabel(auditInitiatingSource(entry), t)}
          </div>
        </div>
      </button>
    </div>
  );
}
function AuditDetail({
  entry,
  zone,
  identities,
  onOperation,
}: {
  entry: TimelineEntry;
  zone: string;
  identities: readonly IdentityOption[];
  onOperation(correlationId: string): void;
}) {
  const { t, dateTime } = useI18n();
  const detail = useQuery({
    queryKey: ["audit-entry", entry.id],
    queryFn: () => apiCall("get", "/v1/audit-log/{id}", { path: { id: entry.id } }),
    retry: false,
  });
  const current = detail.data && isAuditEntry(detail.data) ? detail.data : entry;
  if (detail.error instanceof ApiError && detail.error.status === 403) return <ForbiddenState />;
  if (detail.error instanceof ApiError && detail.error.status === 404)
    return (
      <DataState
        state="empty"
        line={t("audit.timeline.detailUnavailable")}
        testId="audit-detail-unavailable"
      />
    );
  const missing = t("audit.timeline.notRecorded");
  const actor = actorName(current, identities, t);
  const reason = auditReasonLabel(current.reason, t);
  const recordedAccess = auditRecordedAccess(current);
  const facts: { label: string; value: string; tech?: boolean }[] = [
    { tech: true, label: t("audit.timeline.actionCode"), value: current.action },
    { label: t("audit.timeline.local"), value: `${dateTime(current.ts)} · ${zone}` },
    { tech: true, label: t("audit.timeline.utc"), value: new Date(current.ts).toISOString() },
    { tech: true, label: t("audit.timeline.eventId"), value: current.id },
    { label: t("audit.column.actor"), value: actor },
    {
      label: t("audit.timeline.actorType"),
      value: current.actor_type ? actorTypeLabel(current.actor_type, t).text : missing,
    },
    { tech: true, label: t("audit.timeline.actorId"), value: current.actor_id || missing },
    { label: t("audit.timeline.accessType"), value: accessLabel(current.access_type, t) },
    { tech: true, label: t("audit.timeline.apiKey"), value: current.api_key_id || missing },
    ...(recordedAccess.apiKeyId
      ? [{ tech: true, label: t("audit.timeline.recordedApiKey"), value: recordedAccess.apiKeyId }]
      : []),
    { tech: true, label: t("audit.timeline.session"), value: current.session_id || missing },
    ...(recordedAccess.sessionId
      ? [
          {
            tech: true,
            label: t("audit.timeline.recordedSession"),
            value: recordedAccess.sessionId,
          },
        ]
      : []),
    {
      tech: true,
      label: t("audit.timeline.oauthClient"),
      value: current.oauth_client_id || missing,
    },
    {
      label: t("audit.timeline.credentialOrigin"),
      value:
        current.credential_origin === "cli_oauth_session"
          ? t("audit.timeline.credentialOrigin.cliOAuthSession")
          : missing,
    },
    ...(unverifiedApiKeyClient(current)
      ? [
          {
            label: t("audit.timeline.clientApplication"),
            value: t("audit.timeline.clientApplication.unverifiedApiKey"),
          },
        ]
      : []),
    { tech: true, label: t("audit.timeline.execution"), value: current.execution_id || missing },
    {
      tech: true,
      label: t("audit.timeline.conversation"),
      value: current.conversation_id || missing,
    },
    { tech: true, label: t("audit.timeline.workflow"), value: current.workflow_id || missing },
    ...auditTaskFacts(current, t, dateTime),
    {
      label: t("audit.timeline.resourceType"),
      value: auditResourceLabel(current.resource_type, t).text,
    },
    { tech: true, label: t("audit.timeline.resourceId"), value: current.resource_id || missing },
    { label: t("audit.timeline.initiated"), value: sourceLabel(auditInitiatingSource(current), t) },
    { label: t("audit.timeline.executed"), value: sourceLabel(current.execution_source, t) },
    { label: t("audit.timeline.recordedSource"), value: sourceLabel(current.request_source, t) },
    { label: t("audit.column.result"), value: auditResultLabel(current.result, t).text },
    {
      label: t("audit.column.reason"),
      value: reason
        ? reason.machine
          ? t("audit.timeline.otherReason")
          : reason.text
        : current.reason_redacted
          ? t("audit.timeline.otherReason")
          : missing,
    },
    { tech: true, label: t("audit.timeline.trace"), value: current.trace_id || missing },
    { tech: true, label: t("audit.timeline.operation"), value: current.correlation_id || missing },
    {
      label: t("audit.timeline.changedFields"),
      value: current.changed_fields?.length
        ? changedFieldsDescription(current.changed_fields, t)
        : missing,
    },
  ];
  return (
    <div className="flex flex-col gap-5" data-testid="audit-detail-facts">
      {detail.isPending && <TimelineSkeleton />}
      {detail.error && (
        <DataState
          state="error"
          line={t("audit.detail.refreshFailed")}
          onRetry={() => void detail.refetch()}
          testId="audit-detail-stale"
        />
      )}
      <div
        className={`rounded-lg border p-4 ${current.result === "denied" || current.result === "error" ? "border-destructive/30 bg-destructive/5 text-destructive-ink" : "border-success/40 bg-success/10 text-success-ink"}`}
      >
        <div className="text-sm font-semibold">{auditResultLabel(current.result, t).text}</div>
        <div className="mt-1 text-xs">{actionLabel(current.action, t)}</div>
      </div>
      <section className="rounded-lg border p-4" data-testid="audit-change-summary">
        <SectionHeading className="mb-3 text-sm font-semibold">
          {t("audit.timeline.changeSummary")}
        </SectionHeading>
        {current.changes?.length ? (
          <div className="flex flex-col gap-3">
            {current.changes.map((change) => (
              <div key={change.field} className="border-t pt-2 text-xs">
                <div className="font-medium">{changeFieldLabel(change.field, t)}</div>
                <code
                  className="mt-0.5 block text-[11px] text-muted-foreground"
                  title={t("audit.timeline.fieldId")}
                >
                  {change.field}
                </code>
                <div className="mt-1 grid gap-2 sm:grid-cols-2">
                  <div>
                    <span className="text-muted-foreground">
                      {t("audit.timeline.beforeValue")}:{" "}
                    </span>
                    {auditChangeValue(change.field, change.before, current.resource_type, t)}
                  </div>
                  <div>
                    <span className="text-muted-foreground">
                      {t("audit.timeline.afterValue")}:{" "}
                    </span>
                    {auditChangeValue(change.field, change.after, current.resource_type, t)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{t("audit.timeline.noChangeValues")}</p>
        )}
      </section>
      <FactList
        items={facts
          .filter((fact) => !fact.tech)
          .map((fact) => ({
            label: fact.label,
            value: <span className="break-all">{fact.value}</span>,
          }))}
      />
      <TechDetail
        kind="audit"
        testId="audit-detail"
        rows={facts
          .filter((fact) => fact.tech && fact.value !== missing)
          .map((fact) => [fact.label, fact.value])}
      />
      {current.correlation_id ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => onOperation(current.correlation_id!)}
          data-testid="audit-related-operation"
        >
          {t("audit.timeline.sameOperation")}
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">{t("audit.timeline.unknownRelation")}</p>
      )}
    </div>
  );
}
export function AuditTimelinePage() {
  const { t, dateTime, locale } = useI18n();
  const session = useSession();
  const allowed = session.permissions.includes("audit:read");
  const zone = useMemo(localTimeZone, []);
  const [draft, setDraft] = useState<FilterState>(fromUrl);
  const [filter, setFilter] = useState<FilterState>(fromUrl);
  const [filterError, setFilterError] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(
    () => !validAuditCorrelationId(fromUrl().correlationId),
  );
  const [group, setGroup] = useState<AuditGroup>("day");
  const [selectedId, setSelectedId] = useState<string | null>(
    () => validUrlUuid(new URLSearchParams(window.location.search).get("entry")) || null,
  );
  const [manualClose, setManualClose] = useState(false);
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 1600px)").matches);
  const [newEvents, setNewEvents] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const previousFirst = useRef<string | null>(null);
  const rendered = useRef<{ filter: string; first: string | null; height: number }>({
    filter: "",
    first: null,
    height: 0,
  });
  const live = useLiveQueryOptions();
  const liveStatus = useLiveStatus();
  const readable = canReadDirectory(session);
  const people = useQuery({
    queryKey: ["audit-directory", "people"],
    enabled: allowed && readable,
    queryFn: () => apiCall("get", "/v1/identity/users", { query: { limit: 200 } }),
    ...live,
  });
  const accounts = useQuery({
    queryKey: ["audit-directory", "system-accounts"],
    enabled: allowed && readable,
    queryFn: () => apiCall("get", "/v1/identity/system-accounts", {}),
    ...live,
  });
  const identities = useMemo(
    () => auditIdentityOptions(people.data?.items ?? [], accounts.data?.items ?? []),
    [people.data, accounts.data],
  );
  const can = (permission: string) => session.permissions.includes(permission);
  const apiKeys = useQuery({
    queryKey: API_KEYS_QUERY,
    enabled: allowed && can("api_key:read"),
    queryFn: () => apiCall("get", "/v1/identity/api-keys", {}),
    ...live,
  });
  const oauthClients = useQuery({
    queryKey: ["admin", "oauth-clients"],
    enabled: allowed && can("mcp_oauth_client:read"),
    queryFn: () => apiCall("get", "/v1/oauth/clients", {}),
    ...live,
  });
  const workflows = useQuery({
    queryKey: ["catalog-workflow-index"],
    enabled: allowed && can("workflow:read"),
    queryFn: () => apiCall("get", "/v1/workflows", { query: { limit: 200 } }),
  });
  const groupNames = useMemo<GroupNames>(
    () => ({
      identities,
      book: auditNameBook({
        apiKeys: apiKeys.data?.items,
        oauthClients: oauthClients.data?.items,
        workflows: workflows.data?.items,
      }),
      time: (at) =>
        new Intl.DateTimeFormat(locale === "de" ? "de-DE" : "en-US", {
          timeZone: zone,
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date(at)),
    }),
    [identities, apiKeys.data, oauthClients.data, workflows.data, locale, zone],
  );
  const invalidAppliedCorrelation = !validAuditCorrelationId(filter.correlationId);
  const params = useMemo<ListParams>(
    () => ({
      ...auditScopeParams(filter.scope),
      ...(filter.resourceType ? { resource_type: filter.resourceType } : {}),
      ...(filter.resourceId ? { resource_id: filter.resourceId } : {}),
      ...(filter.actorType ? { actor_type: filter.actorType } : {}),
      ...(filter.actorId ? { actor_id: filter.actorId } : {}),
      ...(filter.apiKeyId ? { api_key_id: filter.apiKeyId } : {}),
      ...(filter.sessionId ? { session_id: filter.sessionId } : {}),
      ...(filter.accessType ? { access_type: filter.accessType } : {}),
      ...(filter.oauthClientId ? { oauth_client_id: filter.oauthClientId } : {}),
      ...(filter.originSource ? { origin_source: filter.originSource } : {}),
      ...(filter.executionSource ? { execution_source: filter.executionSource } : {}),
      ...(filter.executionId ? { execution_id: filter.executionId } : {}),
      ...(filter.conversationId ? { conversation_id: filter.conversationId } : {}),
      ...(filter.workflowId ? { workflow_id: filter.workflowId } : {}),
      ...(filter.taskId ? { task_id: filter.taskId } : {}),
      ...(filter.taskRunId ? { task_run_id: filter.taskRunId } : {}),
      ...(filter.result ? { result: filter.result } : {}),
      ...(filter.action ? { action: filter.action } : {}),
      ...(filter.traceId ? { trace_id: filter.traceId } : {}),
      ...(filter.correlationId ? { correlation_id: filter.correlationId } : {}),
      ...(filter.from
        ? {
            ts_from: utcFromLocalInputPreservingInstant(
              filter.from,
              zone,
              filter.fromChoice,
              filter.fromInstant,
            ),
          }
        : {}),
      ...(filter.to
        ? {
            ts_to: utcFromLocalInputPreservingInstant(
              filter.to,
              zone,
              filter.toChoice,
              filter.toInstant,
            ),
          }
        : {}),
    }),
    [filter, zone],
  );
  const list = useInfiniteList<TimelineEntry>("/v1/audit-log", params, {
    enabled: allowed && !invalidAppliedCorrelation,
  });
  useEffect(() => {
    if (!allowed || invalidAppliedCorrelation) return;
    const timer = window.setInterval(() => void list.query.refetch(), 60_000);
    return () => window.clearInterval(timer);
  }, [allowed, invalidAppliedCorrelation, list.query.refetch]);
  const rows = list.items;
  const filterKey = JSON.stringify(params);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const first = rows[0]?.id ?? null;
    const old = rendered.current;
    if (
      old.filter === filterKey &&
      old.first &&
      first &&
      old.first !== first &&
      element.scrollTop > 40
    ) {
      element.scrollTop += element.scrollHeight - old.height;
    }
    rendered.current = { filter: filterKey, first, height: element.scrollHeight };
  }, [filterKey, rows]);
  const selected = rows.find((entry) => entry.id === selectedId) ?? null;
  const standalone = useQuery({
    queryKey: ["audit-entry", selectedId],
    enabled: allowed && Boolean(selectedId),
    queryFn: () => apiCall("get", "/v1/audit-log/{id}", { path: { id: selectedId ?? "" } }),
    retry: false,
  });
  const detailUnavailable = standalone.error instanceof ApiError && standalone.error.status === 404;
  const current = detailUnavailable ? null : (standalone.data ?? selected);
  const forbidden =
    (list.query.error instanceof ApiError && list.query.error.status === 403) ||
    (standalone.error instanceof ApiError && standalone.error.status === 403);
  const groups = useMemo(() => groupLoadedAudit(rows, group, zone), [rows, group, zone]);
  const active =
    filter.scope !== "all" ||
    Object.entries(filter).some(
      ([key, value]) =>
        ![
          "scope",
          "from",
          "fromChoice",
          "toChoice",
          "fromInstant",
          "toInstant",
          "resourceQuery",
        ].includes(key) && Boolean(value),
    ) ||
    (Boolean(filter.from) && new URLSearchParams(window.location.search).has("ts_from"));
  const openEntry = useCallback((id: string | null) => {
    setSelectedId(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("entry", id);
    else url.searchParams.delete("entry");
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, []);
  const apply = useCallback(() => {
    if (!validAuditCorrelationId(draft.correlationId)) {
      setFilterError(null);
      return;
    }
    const selectedResourceId =
      draft.resourceId ||
      (draft.resourceType && validUrlUuid(draft.resourceQuery.trim())
        ? draft.resourceQuery.trim()
        : "");
    if (draft.resourceQuery.trim() && !selectedResourceId) {
      setFilterError(t("audit.timeline.selectResource"));
      return;
    }
    if (
      [
        draft.actorId,
        draft.apiKeyId,
        draft.sessionId,
        draft.executionId,
        draft.conversationId,
        draft.workflowId,
        draft.taskId,
        draft.taskRunId,
      ].some((id) => id && !validUrlUuid(id))
    ) {
      setFilterError(t("audit.timeline.invalidId"));
      return;
    }
    if (draft.oauthClientId && !/^[a-zA-Z0-9._:-]{1,128}$/.test(draft.oauthClientId)) {
      setFilterError(t("audit.timeline.invalidOAuthClient"));
      return;
    }
    const from = utcFromLocalInputPreservingInstant(
      draft.from,
      zone,
      draft.fromChoice,
      draft.fromInstant,
    );
    const to = utcFromLocalInputPreservingInstant(draft.to, zone, draft.toChoice, draft.toInstant);
    if ((draft.from && !from) || (draft.to && !to)) {
      setFilterError(t("audit.timeline.invalidTime"));
      return;
    }
    if (from && to && from >= to) {
      setFilterError(t("audit.timeline.invalidRange"));
      return;
    }
    const scope = normalizedAuditScope(draft.scope, draft.action, draft.actorType);
    setFilterError(null);
    setDraft((current) => ({ ...current, scope }));
    setFilter({
      ...draft,
      scope,
      resourceId: selectedResourceId,
      fromInstant: from ?? "",
      toInstant: to ?? "",
    });
    openEntry(null);
    setManualClose(false);
    setFilterOpen(false);
    setNewEvents(0);
    const url = new URL(window.location.href);
    for (const key of [
      "resource_type",
      "resource_id",
      "actor_type",
      "actor_id",
      "api_key_id",
      "session_id",
      "access_type",
      "oauth_client_id",
      "origin_source",
      "execution_source",
      "execution_id",
      "conversation_id",
      "workflow_id",
      "task_id",
      "task_run_id",
      "result",
      "action",
      "trace_id",
      "correlation_id",
      "ts_from",
      "ts_to",
      "scope",
    ])
      url.searchParams.delete(key);
    const next: Record<string, string | null> = {
      resource_type: draft.resourceType,
      resource_id: selectedResourceId,
      actor_type: draft.actorType,
      actor_id: draft.actorId,
      api_key_id: draft.apiKeyId,
      session_id: draft.sessionId,
      access_type: draft.accessType,
      oauth_client_id: draft.oauthClientId,
      origin_source: draft.originSource,
      execution_source: draft.executionSource,
      execution_id: draft.executionId,
      conversation_id: draft.conversationId,
      workflow_id: draft.workflowId,
      task_id: draft.taskId,
      task_run_id: draft.taskRunId,
      result: draft.result,
      action: draft.action,
      trace_id: draft.traceId,
      correlation_id: draft.correlationId,
      ts_from: from,
      ts_to: to,
      scope: scope === "all" ? null : scope,
    };
    for (const [key, value] of Object.entries(next)) if (value) url.searchParams.set(key, value);
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
    scrollRef.current?.scrollTo({ top: 0 });
  }, [draft, t, zone, openEntry]);
  const clear = () => {
    setDraft(EMPTY);
    setFilter(EMPTY);
    openEntry(null);
    setManualClose(false);
    setFilterError(null);
    setFilterOpen(false);
    setNewEvents(0);
    const url = new URL(window.location.href);
    for (const key of [
      "resource_type",
      "resource_id",
      "actor_type",
      "actor_id",
      "api_key_id",
      "session_id",
      "access_type",
      "oauth_client_id",
      "origin_source",
      "execution_source",
      "execution_id",
      "conversation_id",
      "workflow_id",
      "task_id",
      "task_run_id",
      "result",
      "action",
      "trace_id",
      "correlation_id",
      "ts_from",
      "ts_to",
      "scope",
    ])
      url.searchParams.delete(key);
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  };
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1600px)");
    const update = () => {
      setWide(media.matches);
      if (media.matches) setManualClose(false);
    };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (wide && rows.length && !selectedId && !manualClose) openEntry(rows[0]!.id);
  }, [wide, rows, selectedId, manualClose, openEntry]);
  useEffect(() => {
    previousFirst.current = null;
    setNewEvents(0);
  }, [filterKey]);
  useEffect(() => {
    const id = rows[0]?.id;
    if (!id) return;
    if (previousFirst.current && previousFirst.current !== id && !list.query.isPending) {
      const count = rows.findIndex((row) => row.id === previousFirst.current);
      if (count > 0) setNewEvents((previous) => previous + count);
    }
    previousFirst.current = id;
  }, [rows, list.query.isPending]);
  useEffect(() => {
    const target = sentinelRef.current;
    if (!target || !list.infinite.hasNextPage || list.infinite.isFetchingNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void list.infinite.fetchNextPage();
      },
      { root: scrollRef.current, rootMargin: "200px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [list.infinite.hasNextPage, list.infinite.isFetchingNextPage, list.infinite.fetchNextPage]);
  useEffect(() => {
    if (!newEvents) return;
    const id = toast(
      t(newEvents === 1 ? "audit.timeline.newEventOne" : "audit.timeline.newEvents", {
        count: newEvents,
      }),
      {
        action: {
          label: t("audit.timeline.show"),
          onClick: () => {
            setNewEvents(0);
            scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
          },
        },
      },
    );
    return () => {
      toast.dismiss(id);
    };
  }, [newEvents, t]);
  const onOperation = (correlationId: string) => {
    const next = { ...EMPTY, correlationId };
    setDraft(next);
    setFilter(next);
    openEntry(null);
    const url = new URL(window.location.href);
    for (const key of [
      "resource_type",
      "resource_id",
      "actor_type",
      "actor_id",
      "api_key_id",
      "session_id",
      "access_type",
      "oauth_client_id",
      "origin_source",
      "execution_source",
      "execution_id",
      "conversation_id",
      "workflow_id",
      "task_id",
      "task_run_id",
      "result",
      "action",
      "trace_id",
      "ts_from",
      "ts_to",
      "scope",
    ])
      url.searchParams.delete(key);
    url.searchParams.set("correlation_id", correlationId);
    url.searchParams.delete("entry");
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
    scrollRef.current?.scrollTo({ top: 0 });
  };
  const permission = current ? auditResourcePermission(current.resource_type) : null;
  const href =
    current && permission && session.permissions.includes(permission)
      ? auditResourceHref(current.resource_type, current.resource_id, current.task_id)
      : null;
  if (!allowed || forbidden)
    return (
      <Page
        kind="list"
        surface="audit"
        testId="resource-audit"
        scroll="page"
        header={<TopPageHeader title={t("nav.audit")} />}
      >
        <ForbiddenState />
      </Page>
    );
  return (
    <Page
      kind="workspace"
      surface="audit"
      testId="resource-audit"
      scroll="content"
      header={<TopPageHeader title={t("nav.audit")} />}
    >
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden" data-testid="audit-workspace">
        <aside
          className="hidden w-[280px] shrink-0 overflow-y-auto border-r bg-muted/10 min-[1600px]:block min-[1920px]:w-[320px]"
          aria-label={t("audit.timeline.filters")}
        >
          <FilterForm
            draft={draft}
            setDraft={setDraft}
            apply={apply}
            clear={clear}
            error={filterError}
            zone={zone}
            identities={identities}
          />
        </aside>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 flex-col gap-3 border-b px-4 py-3 sm:px-8">
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                className="min-[1600px]:hidden"
                onClick={() => setFilterOpen(true)}
                data-testid="audit-filter-open"
              >
                <Filter className="size-4" />
                {t("audit.timeline.filters")}
              </Button>
              <Select value={group} onValueChange={(value) => setGroup(value as AuditGroup)}>
                <SelectTrigger
                  size="sm"
                  aria-label={t("audit.timeline.group")}
                  data-testid="audit-group"
                  className="w-auto"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AUDIT_GROUPS.map((value) => (
                    <SelectItem key={value} value={value} data-testid={`audit-group-${value}`}>
                      {t(GROUP_KEYS[value])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="truncate text-xs text-muted-foreground">
                <CalendarDays className="mr-1 inline size-3" />
                {zone}
              </span>
              <Button
                className="ml-auto sm:hidden"
                size="sm"
                type="submit"
                form="audit-quick-filters"
                data-testid="audit-quick-apply"
              >
                {t("audit.timeline.apply")}
              </Button>
            </div>
            <form
              id="audit-quick-filters"
              className="sm:hidden"
              data-testid="audit-quick-filters"
              onSubmit={(event) => {
                event.preventDefault();
                apply();
              }}
            >
              <FocusFields draft={draft} setDraft={setDraft} zone={zone} compact />
              {filterError && (
                <p role="alert" className="mt-3 text-xs text-destructive">
                  {filterError}
                </p>
              )}
            </form>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 text-xs text-muted-foreground sm:px-8">
            <span>
              {t(liveStatus.status === "live" ? "audit.timeline.live" : "audit.timeline.offline")}
            </span>
            {list.query.dataUpdatedAt ? (
              <span>
                {t("audit.timeline.lastUpdated", {
                  time: dateTime(new Date(list.query.dataUpdatedAt)),
                })}
              </span>
            ) : null}
          </div>
          <div
            ref={scrollRef}
            className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8"
            data-testid="audit-timeline-scroll"
          >
            <div style={{ maxWidth: "56rem" }}>
              {list.query.isError && rows.length > 0 && (
                <DataState
                  state="error"
                  line={t("audit.timeline.refreshFailed")}
                  onRetry={() => void list.query.refetch()}
                  testId="audit-refresh-failed"
                />
              )}
              {invalidAppliedCorrelation ? (
                <p className="py-12 text-center text-sm text-destructive">
                  {t("audit.timeline.invalidCorrelationId")}
                </p>
              ) : list.query.isPending ? (
                <TimelineSkeleton />
              ) : list.query.isError && rows.length === 0 ? (
                <DataState
                  state="error"
                  line={t("resource.loadFailed", { resource: t("nav.audit") })}
                  onRetry={() => void list.query.refetch()}
                  testId="audit-timeline-error"
                />
              ) : rows.length === 0 ? (
                <div className="py-12 text-center">
                  <Search aria-hidden className="mx-auto mb-3 size-7 text-muted-foreground" />
                  <p className="text-sm">
                    {t(active ? "audit.timeline.filteredEmpty" : "audit.timeline.empty")}
                  </p>
                  {active ? null : (
                    <p className="mt-1 text-sm text-muted-foreground">{t("audit.emptyHelp")}</p>
                  )}
                  {active && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-4"
                      onClick={clear}
                      data-testid="audit-empty-clear"
                    >
                      {t("catalog.clearFilters")}
                    </Button>
                  )}
                </div>
              ) : (
                <div className="flex flex-col gap-7">
                  {groups.map((bucket) => (
                    <section
                      key={bucket.key}
                      className="relative ml-14 border-l-2 border-border pl-0"
                      aria-label={groupLabel(
                        bucket.key,
                        group,
                        bucket.entries[0]!,
                        zone,
                        locale,
                        groupNames,
                        t,
                      )}
                    >
                      <span
                        aria-hidden
                        className="absolute -left-[9px] top-0 size-4 rounded-full border-[3px] border-background bg-slate-400"
                      />
                      <SectionHeading className="mb-4 flex flex-wrap items-baseline gap-2 pl-6 text-sm font-semibold text-muted-foreground sm:pl-8">
                        {groupLabel(
                          bucket.key,
                          group,
                          bucket.entries[0]!,
                          zone,
                          locale,
                          groupNames,
                          t,
                        )}
                        {list.infinite.hasNextPage && (
                          <span className="text-xs font-normal">
                            {t("audit.timeline.groupPartial")}
                          </span>
                        )}
                      </SectionHeading>
                      {bucket.entries.map((entry) => (
                        <EventCard
                          key={entry.id}
                          entry={entry}
                          selected={selectedId === entry.id}
                          open={() => {
                            setManualClose(false);
                            openEntry(entry.id);
                          }}
                          zone={zone}
                          identities={identities}
                        />
                      ))}
                    </section>
                  ))}
                </div>
              )}
              {list.infinite.hasNextPage && (
                <div ref={sentinelRef} className="py-6 text-center">
                  {list.infinite.isFetchingNextPage && <TimelineSkeleton />}
                  {list.query.isFetchNextPageError && (
                    <p role="alert" className="mb-2 text-xs text-destructive">
                      {t("audit.timeline.moreFailed")}
                    </p>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid="audit-load-more"
                    disabled={list.infinite.isFetchingNextPage}
                    onClick={() => void list.infinite.fetchNextPage()}
                  >
                    {t("audit.timeline.earlier")}
                  </Button>
                </div>
              )}
              {rows.length > 0 && !list.infinite.hasNextPage && (
                <p className="py-8 text-center text-xs text-muted-foreground">
                  {t("audit.timeline.end")}
                </p>
              )}
            </div>
          </div>
        </div>
        <FilterSheet
          open={filterOpen}
          onOpenChange={setFilterOpen}
          title={t("audit.timeline.filters")}
        >
          <FilterForm
            draft={draft}
            setDraft={setDraft}
            apply={apply}
            clear={clear}
            error={filterError}
            zone={zone}
            identities={identities}
          />
        </FilterSheet>
        <RecordSheet
          dock={wide}
          open={Boolean(selectedId)}
          onOpenChange={(open) => {
            if (!open) {
              setManualClose(true);
              openEntry(null);
            }
          }}
          testId="audit-detail"
          closeTestId="audit-detail-close"
          titleTestId="audit-detail-title"
          title={current ? actionLabel(current.action, t) : t("audit.timeline.detail")}
          badge={
            current ? (
              <StatusBadge
                state={current.result}
                label={auditResultLabel(current.result, t).text}
              />
            ) : null
          }
          menu={
            href ? (
              <a
                href={href}
                aria-label={t("audit.timeline.openResource")}
                title={t("audit.timeline.openResource")}
                className="rounded p-1 text-muted-foreground hover:text-foreground"
                data-testid="audit-detail-open"
              >
                <ExternalLink className="size-4" />
              </a>
            ) : null
          }
        >
          {current ? (
            <AuditDetail
              entry={current}
              zone={zone}
              identities={identities}
              onOperation={onOperation}
            />
          ) : detailUnavailable ? (
            <DataState
              state="empty"
              line={t("audit.timeline.detailUnavailable")}
              testId="audit-detail-unavailable"
            />
          ) : standalone.isError ? (
            <DataState
              state="error"
              line={t("audit.detail.refreshFailed")}
              onRetry={() => void standalone.refetch()}
            />
          ) : (
            <TimelineSkeleton />
          )}
        </RecordSheet>
      </div>
    </Page>
  );
}
