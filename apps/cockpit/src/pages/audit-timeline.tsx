import { useQuery } from "@tanstack/react-query";
import { CalendarDays, ChevronDown, ExternalLink, Filter, Search } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiError, apiRequest } from "@/api/client";
import { type ActorDirectory, actorDirectory } from "@/app/actor-directory-model";
import { useLiveQueryOptions, useLiveStatus } from "@/app/live-events";
import { useSession } from "@/app/session";
import { useNameIndex } from "@/app/use-decisions";
import {
  Button,
  DataState,
  FactList,
  FilterSheet,
  Page,
  PageHeader,
  RecordSheet,
  SectionHeading,
  Skeleton,
  StatusBadge,
  TimelineGroupingTabs,
} from "@/components/cockpit/patterns";
import { ForbiddenState } from "@/components/failure-state";
import type { Locale, TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { type ListParams, useInfiniteList } from "@/lib/use-infinite-list";
import {
  type AuditScope,
  actorTypeLabel,
  auditActionLabel,
  auditActorName,
  auditCorrelationFromUrl,
  auditObjectName,
  auditReasonLabel,
  auditResourceHref,
  auditResourceLabel,
  auditResultLabel,
  auditScopeParams,
  canReadDirectory,
  initialAuditFilter,
  isAuditEntry,
  normalizedAuditScope,
} from "./audit-model";
import {
  AUDIT_GROUPS,
  type AuditGroup,
  auditInitiatingSource,
  auditRecordedAccess,
  groupLoadedAudit,
  localDateTimeInput,
  localTimeZone,
  type TimelineEntry,
  utcChoiceForInstant,
  utcChoicesForLocalInput,
  utcFromLocalInputPreservingInstant,
  validAuditCorrelationId,
} from "./audit-timeline-model";

type Source =
  | "api"
  | "cli"
  | "scheduler"
  | "mcp"
  | "webhook"
  | "tool-chain"
  | "ui"
  | "chat"
  | "queue";
const SOURCES: Source[] = [
  "ui",
  "chat",
  "cli",
  "mcp",
  "api",
  "webhook",
  "scheduler",
  "tool-chain",
  "queue",
];
const SOURCE_KEYS: Record<Source, TranslationKey> = {
  api: "audit.timeline.source.api",
  cli: "audit.timeline.source.cli",
  scheduler: "audit.timeline.source.scheduler",
  mcp: "audit.timeline.source.mcp",
  webhook: "audit.timeline.source.webhook",
  "tool-chain": "audit.timeline.source.tool-chain",
  ui: "audit.timeline.source.ui",
  chat: "audit.timeline.source.chat",
  queue: "audit.timeline.source.queue",
};
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
const ACCESS_TYPES = [
  "api_key",
  "browser_session",
  "mcp_oauth",
  "token_exchange",
  "external_bearer",
  "portal_token",
] as const;
type AccessType = (typeof ACCESS_TYPES)[number];
const ACCESS_KEYS: Record<AccessType, TranslationKey> = {
  api_key: "audit.timeline.accessType.apiKey",
  browser_session: "audit.timeline.accessType.browserSession",
  mcp_oauth: "audit.timeline.accessType.mcpOAuth",
  token_exchange: "audit.timeline.accessType.tokenExchange",
  external_bearer: "audit.timeline.accessType.externalBearer",
  portal_token: "audit.timeline.accessType.portalToken",
};
interface FilterState {
  scope: AuditScope;
  resourceType: string;
  resourceId: string;
  resourceQuery: string;
  actorType: string;
  actorId: string;
  apiKeyId: string;
  sessionId: string;
  accessType: string;
  oauthClientId: string;
  originSource: string;
  executionSource: string;
  executionId: string;
  conversationId: string;
  workflowId: string;
  result: string;
  action: string;
  traceId: string;
  correlationId: string;
  from: string;
  to: string;
  fromChoice: string;
  toChoice: string;
  fromInstant: string;
  toInstant: string;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validUrlUuid(value: string | null): string {
  return value && UUID.test(value) ? value : "";
}
function fromUrl(): FilterState {
  const search = typeof window === "undefined" ? "" : window.location.search;
  const linked = initialAuditFilter(search, Date.now());
  const params = new URLSearchParams(search);
  const accessType = params.get("access_type") ?? "";
  const oauthClientId = params.get("oauth_client_id") ?? "";
  const actorType = params.get("actor_type") ?? "";
  const validActorType = ["user", "system_account", "system", "unknown"].includes(actorType)
    ? actorType
    : "";
  const originSource = params.get("origin_source") ?? "";
  const executionSource = params.get("execution_source") ?? "";
  const result = params.get("result") ?? "";
  const action = linked.actions.join(",");
  const zone = localTimeZone();
  return {
    scope: normalizedAuditScope(linked.scope ?? "all", action, validActorType),
    resourceType: linked.resourceType ?? "",
    resourceId: linked.resourceId ?? "",
    resourceQuery: linked.resourceId ?? "",
    actorType: validActorType,
    actorId: validUrlUuid(params.get("actor_id")),
    apiKeyId: validUrlUuid(params.get("api_key_id")),
    sessionId: validUrlUuid(params.get("session_id")),
    accessType: ACCESS_TYPES.some((access) => access === accessType) ? accessType : "",
    oauthClientId: /^[a-zA-Z0-9._:-]{1,128}$/.test(oauthClientId) ? oauthClientId : "",
    originSource: SOURCES.includes(originSource as Source) ? originSource : "",
    executionSource: SOURCES.includes(executionSource as Source) ? executionSource : "",
    executionId: validUrlUuid(params.get("execution_id")),
    conversationId: validUrlUuid(params.get("conversation_id")),
    workflowId: validUrlUuid(params.get("workflow_id")),
    result: ["success", "denied", "error"].includes(result) ? result : "",
    action,
    traceId: linked.traceId ?? "",
    correlationId: auditCorrelationFromUrl(search) ?? "",
    from: localDateTimeInput(linked.tsFrom, zone),
    to: localDateTimeInput(linked.tsTo, zone),
    fromChoice: utcChoiceForInstant(linked.tsFrom, zone),
    toChoice: utcChoiceForInstant(linked.tsTo, zone),
    fromInstant: linked.tsFrom ?? "",
    toInstant: linked.tsTo ?? "",
  };
}
const EMPTY: FilterState = {
  scope: "all",
  resourceType: "",
  resourceId: "",
  resourceQuery: "",
  actorType: "",
  actorId: "",
  apiKeyId: "",
  sessionId: "",
  accessType: "",
  oauthClientId: "",
  originSource: "",
  executionSource: "",
  executionId: "",
  conversationId: "",
  workflowId: "",
  result: "",
  action: "",
  traceId: "",
  correlationId: "",
  from: "",
  to: "",
  fromChoice: "",
  toChoice: "",
  fromInstant: "",
  toInstant: "",
};
function sourceLabel(
  source: string | null | undefined,
  t: ReturnType<typeof useI18n>["t"],
): string {
  return source && Object.hasOwn(SOURCE_KEYS, source)
    ? t(SOURCE_KEYS[source as Source])
    : t("audit.timeline.notRecorded");
}
function accessLabel(
  access: string | null | undefined,
  t: ReturnType<typeof useI18n>["t"],
): string {
  return access && Object.hasOwn(ACCESS_KEYS, access)
    ? t(ACCESS_KEYS[access as AccessType])
    : t("audit.timeline.notRecorded");
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
function resourcePermission(type: string): string | null {
  const permissions: Record<string, string> = {
    workflow: "workflow:read",
    connector: "connector:read",
    knowledge_source: "knowledge:read",
    skill: "skill:read",
    file: "file:read",
    execution: "execution:read",
    conversation: "conversation:read",
  };
  return permissions[type] ?? null;
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-foreground">
      <legend className="mb-1.5">{label}</legend>
      {children}
    </fieldset>
  );
}
const inputClass =
  "h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring";
interface IdentityOption {
  kind: "user" | "system_account";
  id: string;
  label: string;
}
function FilterForm({
  draft,
  setDraft,
  apply,
  clear,
  error,
  zone,
  identities,
}: {
  draft: FilterState;
  setDraft: React.Dispatch<React.SetStateAction<FilterState>>;
  apply(): void;
  clear(): void;
  error: string | null;
  zone: string;
  identities: readonly IdentityOption[];
}) {
  const { t } = useI18n();
  const [identityOpen, setIdentityOpen] = useState(false);
  const [originOpen, setOriginOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(() => !validAuditCorrelationId(draft.correlationId));
  const set = (key: keyof FilterState, value: string) =>
    setDraft((current) => ({
      ...current,
      [key]: value,
      ...(key === "scope" && value === "decisions" ? { action: "" } : {}),
      ...(key === "scope" && value === "operations" ? { actorType: "" } : {}),
      ...(key === "from" ? { fromChoice: "", fromInstant: "" } : {}),
      ...(key === "to" ? { toChoice: "", toInstant: "" } : {}),
      ...(key === "fromChoice" ? { fromInstant: "" } : {}),
      ...(key === "toChoice" ? { toInstant: "" } : {}),
    }));
  const fromChoices = draft.from ? utcChoicesForLocalInput(draft.from, zone) : [];
  const toChoices = draft.to ? utcChoicesForLocalInput(draft.to, zone) : [];
  const resourceSearch = useDebouncedValue(draft.resourceQuery);
  const resources = useQuery({
    queryKey: ["audit-resource-search", resourceSearch],
    enabled: resourceSearch.trim().length >= 2,
    queryFn: () =>
      apiRequest<{
        items: Array<{ resource_type: string; resource_id: string; resource_name: string | null }>;
      }>(`/v1/audit-log/resources?search=${encodeURIComponent(resourceSearch.trim())}`),
    retry: false,
  });
  useEffect(() => {
    if (!draft.resourceId || draft.resourceQuery !== draft.resourceId) return;
    const match = resources.data?.items.find(
      (item) =>
        item.resource_id === draft.resourceId &&
        item.resource_type === draft.resourceType &&
        Boolean(item.resource_name),
    );
    if (!match?.resource_name) return;
    setDraft((current) =>
      current.resourceId === match.resource_id && current.resourceQuery === current.resourceId
        ? { ...current, resourceQuery: match.resource_name ?? current.resourceId }
        : current,
    );
  }, [draft.resourceId, draft.resourceQuery, draft.resourceType, resources.data, setDraft]);
  return (
    <form
      className="flex flex-col gap-5 p-5"
      onSubmit={(event) => {
        event.preventDefault();
        apply();
      }}
      data-testid="audit-filters"
    >
      <div className="space-y-3">
        <SectionHeading className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("audit.timeline.focus")}
        </SectionHeading>
        <Field label={t("audit.timeline.resourceId")}>
          <div className="relative">
            <Search
              aria-hidden
              className="absolute left-2.5 top-2.5 size-4 text-muted-foreground"
            />
            <input
              className={`${inputClass} pl-9`}
              value={draft.resourceQuery}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  resourceQuery: event.target.value,
                  resourceId: "",
                }))
              }
              placeholder={t("audit.timeline.resourceSearch")}
              data-testid="audit-resource-search"
            />
          </div>
        </Field>
        {!draft.resourceId && resources.data?.items?.length ? (
          <div
            className="max-h-40 overflow-y-auto rounded-md border"
            data-testid="audit-resource-suggestions"
          >
            {resources.data.items.map((item) => (
              <button
                type="button"
                data-testid="audit-resource-suggestion"
                key={`${item.resource_type}:${item.resource_id}`}
                className="block w-full border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-muted"
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    resourceType: item.resource_type,
                    resourceId: item.resource_id,
                    resourceQuery: item.resource_name || item.resource_id,
                  }))
                }
              >
                <span className="block font-medium">{item.resource_name || item.resource_id}</span>
                <span className="block text-xs text-muted-foreground">
                  {auditResourceLabel(item.resource_type, t).text} · {item.resource_id}
                </span>
              </button>
            ))}
          </div>
        ) : null}
        <Field label={`${t("audit.timeline.from")} · ${zone}`}>
          <input
            type="datetime-local"
            className={inputClass}
            value={draft.from}
            onChange={(event) => set("from", event.target.value)}
            data-testid="audit-from"
          />
        </Field>
        {fromChoices.length > 1 && (
          <Field label={t("audit.timeline.offset")}>
            <select
              className={inputClass}
              value={draft.fromChoice}
              onChange={(event) => set("fromChoice", event.target.value)}
            >
              <option value="">{t("audit.timeline.chooseOffset")}</option>
              {fromChoices.map((choice) => (
                <option key={choice.instant} value={choice.instant}>
                  {choice.offset}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label={`${t("audit.timeline.to")} · ${zone}`}>
          <input
            type="datetime-local"
            className={inputClass}
            value={draft.to}
            onChange={(event) => set("to", event.target.value)}
            data-testid="audit-to"
          />
        </Field>
        {toChoices.length > 1 && (
          <Field label={t("audit.timeline.offset")}>
            <select
              className={inputClass}
              value={draft.toChoice}
              onChange={(event) => set("toChoice", event.target.value)}
            >
              <option value="">{t("audit.timeline.chooseOffset")}</option>
              {toChoices.map((choice) => (
                <option key={choice.instant} value={choice.instant}>
                  {choice.offset}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      <div className="border-t pt-3">
        <button
          type="button"
          data-testid="audit-filter-identity-toggle"
          className="flex w-full items-center justify-between py-1 text-sm font-medium"
          aria-expanded={identityOpen}
          onClick={() => setIdentityOpen(!identityOpen)}
        >
          {t("audit.timeline.identity")}
          <ChevronDown className={`size-4 ${identityOpen ? "rotate-180" : ""}`} />
        </button>
        {identityOpen && (
          <div className="mt-3 space-y-3">
            {identities.length > 0 && (
              <Field label={t("audit.timeline.knownIdentity")}>
                <select
                  className={inputClass}
                  value={
                    identities.some(
                      (option) => option.id === draft.actorId && option.kind === draft.actorType,
                    )
                      ? `${draft.actorType}:${draft.actorId}`
                      : ""
                  }
                  onChange={(event) => {
                    const choice = identities.find(
                      (option) => `${option.kind}:${option.id}` === event.target.value,
                    );
                    if (choice)
                      setDraft((current) => ({
                        ...current,
                        actorType: choice.kind,
                        actorId: choice.id,
                      }));
                  }}
                >
                  <option value="">{t("audit.scope.all")}</option>
                  {identities.map((option) => (
                    <option
                      key={`${option.kind}:${option.id}`}
                      value={`${option.kind}:${option.id}`}
                    >
                      {option.label} · {option.id}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label={t("audit.timeline.actorType")}>
              <select
                className={inputClass}
                value={draft.actorType}
                onChange={(event) => set("actorType", event.target.value)}
              >
                <option value="">{t("audit.scope.all")}</option>
                <option value="user">{t("audit.actor.user")}</option>
                <option value="system_account">{t("audit.actor.systemAccount")}</option>
                <option value="system">{t("audit.actor.system")}</option>
                <option value="unknown">{t("audit.actor.unknown")}</option>
              </select>
            </Field>
            <Field label={t("audit.timeline.actorId")}>
              <input
                className={inputClass}
                value={draft.actorId}
                onChange={(event) => set("actorId", event.target.value)}
              />
            </Field>
            <Field label={t("audit.timeline.apiKey")}>
              <input
                className={inputClass}
                value={draft.apiKeyId}
                onChange={(event) => set("apiKeyId", event.target.value)}
              />
            </Field>
            <Field label={t("audit.timeline.session")}>
              <input
                className={inputClass}
                value={draft.sessionId}
                onChange={(event) => set("sessionId", event.target.value)}
              />
            </Field>
            <Field label={t("audit.timeline.accessType")}>
              <select
                className={inputClass}
                value={draft.accessType}
                onChange={(event) => set("accessType", event.target.value)}
              >
                <option value="">{t("audit.scope.all")}</option>
                {ACCESS_TYPES.map((access) => (
                  <option key={access} value={access}>
                    {t(ACCESS_KEYS[access])}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("audit.timeline.oauthClient")}>
              <input
                className={inputClass}
                value={draft.oauthClientId}
                onChange={(event) => set("oauthClientId", event.target.value)}
              />
            </Field>
          </div>
        )}
      </div>
      <div className="border-t pt-3">
        <button
          type="button"
          data-testid="audit-filter-origin-toggle"
          className="flex w-full items-center justify-between py-1 text-sm font-medium"
          aria-expanded={originOpen}
          onClick={() => setOriginOpen(!originOpen)}
        >
          {t("audit.timeline.origin")}
          <ChevronDown className={`size-4 ${originOpen ? "rotate-180" : ""}`} />
        </button>
        {originOpen && (
          <div className="mt-3 space-y-3">
            <Field label={t("audit.timeline.initiated")}>
              <select
                className={inputClass}
                value={draft.originSource}
                onChange={(event) => set("originSource", event.target.value)}
              >
                <option value="">{t("audit.scope.all")}</option>
                {SOURCES.map((source) => (
                  <option key={source} value={source}>
                    {t(SOURCE_KEYS[source])}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("audit.timeline.executed")}>
              <select
                className={inputClass}
                value={draft.executionSource}
                onChange={(event) => set("executionSource", event.target.value)}
              >
                <option value="">{t("audit.scope.all")}</option>
                {SOURCES.map((source) => (
                  <option key={source} value={source}>
                    {t(SOURCE_KEYS[source])}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        )}
      </div>
      <div className="border-t pt-3">
        <button
          type="button"
          data-testid="audit-filter-more-toggle"
          className="flex w-full items-center justify-between py-1 text-sm font-medium"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen(!moreOpen)}
        >
          {t("audit.timeline.moreFilters")}
          <ChevronDown className={`size-4 ${moreOpen ? "rotate-180" : ""}`} />
        </button>
        {moreOpen && (
          <div className="mt-3 space-y-3">
            <Field label={t("audit.filterScope")}>
              <select
                className={inputClass}
                value={draft.scope}
                onChange={(event) => set("scope", event.target.value)}
              >
                <option value="all">{t("audit.scope.all")}</option>
                <option value="decisions">{t("audit.scope.decisions")}</option>
                <option value="operations">{t("audit.scope.operations")}</option>
              </select>
            </Field>
            <Field label={t("audit.timeline.resourceType")}>
              <input
                className={inputClass}
                value={draft.resourceType}
                onChange={(event) => set("resourceType", event.target.value)}
              />
            </Field>
            <Field label={t("audit.filterResult")}>
              <select
                className={inputClass}
                value={draft.result}
                onChange={(event) => set("result", event.target.value)}
              >
                <option value="">{t("audit.allResults")}</option>
                {["success", "denied", "error"].map((value) => (
                  <option key={value} value={value}>
                    {auditResultLabel(value, t).text}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("audit.timeline.action")}>
              <input
                className={inputClass}
                value={draft.action}
                onChange={(event) => set("action", event.target.value)}
              />
            </Field>
            <Field label={t("audit.timeline.trace")}>
              <input
                className={inputClass}
                value={draft.traceId}
                onChange={(event) => set("traceId", event.target.value)}
              />
            </Field>
            <Field label={t("audit.timeline.operation")}>
              <input
                className={inputClass}
                value={draft.correlationId}
                onChange={(event) => set("correlationId", event.target.value)}
                aria-invalid={!validAuditCorrelationId(draft.correlationId)}
                data-testid="audit-correlation-id"
              />
              {!validAuditCorrelationId(draft.correlationId) && (
                <p role="alert" className="text-xs text-destructive">
                  {t("audit.timeline.invalidCorrelationId")}
                </p>
              )}
            </Field>
            <Field label={t("audit.timeline.execution")}>
              <input
                className={inputClass}
                value={draft.executionId}
                onChange={(event) => set("executionId", event.target.value)}
              />
            </Field>
            <Field label={t("audit.timeline.conversation")}>
              <input
                className={inputClass}
                value={draft.conversationId}
                onChange={(event) => set("conversationId", event.target.value)}
              />
            </Field>
            <Field label={t("audit.timeline.workflow")}>
              <input
                className={inputClass}
                value={draft.workflowId}
                onChange={(event) => set("workflowId", event.target.value)}
              />
            </Field>
          </div>
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-col gap-2">
        <Button type="submit" size="sm" className="w-full" data-testid="audit-filter-apply">
          {t("audit.timeline.apply")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={clear}
          data-testid="audit-filter-clear"
        >
          {t("catalog.clearFilters")}
        </Button>
      </div>
    </form>
  );
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
function groupLabel(
  key: string,
  group: AuditGroup,
  entry: TimelineEntry,
  zone: string,
  locale: Locale,
  directory: ActorDirectory,
  t: ReturnType<typeof useI18n>["t"],
  names: ReturnType<typeof useNameIndex>,
): string {
  if (group === "day")
    return new Intl.DateTimeFormat(locale === "de" ? "de-DE" : "en-US", {
      dateStyle: "full",
      timeZone: zone,
    }).format(new Date(entry.ts));
  if (group === "actor")
    return auditActorName(entry, directory, t)?.text ?? t("audit.timeline.notRecorded");
  if (group === "access") {
    if (entry.api_key_id) {
      const access =
        entry.credential_origin === "cli_oauth_session"
          ? t("audit.timeline.credentialOrigin.cliOAuthSession")
          : accessLabel(entry.access_type || "api_key", t);
      return `${access} · ${entry.api_key_id}`;
    }
    if (entry.session_id)
      return `${accessLabel(entry.access_type || "browser_session", t)} · ${entry.session_id}`;
    if (entry.oauth_client_id)
      return `${accessLabel(entry.access_type || "mcp_oauth", t)} · ${entry.oauth_client_id}`;
    return accessLabel(entry.access_type, t);
  }
  if (group === "resourceType") return auditResourceLabel(entry.resource_type, t).text;
  if (group === "resource")
    return `${auditObjectName(entry, names, t)} · ${auditResourceLabel(entry.resource_type, t).text}`;
  if (group === "source") return sourceLabel(key === "unknown" ? null : key, t);
  if (group === "executed") return sourceLabel(key === "unknown" ? null : key, t);
  if (group === "result") return auditResultLabel(key, t).text;
  return key === "unknown" ? t("audit.timeline.notRecorded") : key;
}
function EventCard({
  entry,
  selected,
  open,
  zone,
  directory,
  names,
}: {
  entry: TimelineEntry;
  selected: boolean;
  open(): void;
  zone: string;
  directory: ActorDirectory;
  names: ReturnType<typeof useNameIndex>;
}) {
  const { t, dateTime, locale } = useI18n();
  const actor = auditActorName(entry, directory, t)?.text ?? t("audit.timeline.notRecorded");
  const label = actionLabel(entry.action, t);
  const local = new Intl.DateTimeFormat(locale === "de" ? "de-DE" : "en-US", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
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
          className={`absolute -left-[35px] top-5 size-4 rounded-full border-[3px] border-background ${entry.result === "denied" || entry.result === "error" ? "bg-destructive" : "bg-emerald-600"}`}
        />
        <time
          dateTime={entry.ts}
          className="absolute -left-[78px] top-5 w-10 text-right text-[11px] font-medium tabular-nums text-muted-foreground sm:-left-[84px] sm:w-12"
        >
          {local.slice(0, 5)}
        </time>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <StatusBadge state={entry.result} label={auditResultLabel(entry.result, t).text} />
        </div>
        <div className="mt-2 text-sm font-semibold">{label}</div>
        <div className="mt-1 text-sm text-muted-foreground">
          {auditObjectName(entry, names, t)} · {auditResourceLabel(entry.resource_type, t).text}
        </div>
        <div className="mt-3 grid gap-x-4 gap-y-1 border-t pt-3 text-xs sm:grid-cols-2">
          <div>
            <span className="text-muted-foreground">{t("audit.column.actor")}: </span>
            {actor}
          </div>
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
  directory,
  onOperation,
}: {
  entry: TimelineEntry;
  zone: string;
  directory: ActorDirectory;
  onOperation(correlationId: string): void;
}) {
  const { t, dateTime } = useI18n();
  const detail = useQuery({
    queryKey: ["audit-entry", entry.id],
    queryFn: () => apiRequest<TimelineEntry>(`/v1/audit-log/${encodeURIComponent(entry.id)}`),
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
  const actor = auditActorName(current, directory, t)?.text ?? missing;
  const reason = auditReasonLabel(current.reason, t);
  const recordedAccess = auditRecordedAccess(current);
  const facts = [
    { label: t("audit.timeline.actionCode"), value: current.action },
    { label: t("audit.timeline.local"), value: `${dateTime(current.ts)} · ${zone}` },
    { label: t("audit.timeline.utc"), value: new Date(current.ts).toISOString() },
    { label: t("audit.timeline.eventId"), value: current.id },
    { label: t("audit.column.actor"), value: actor },
    {
      label: t("audit.timeline.actorType"),
      value: current.actor_type ? actorTypeLabel(current.actor_type, t).text : missing,
    },
    { label: t("audit.timeline.actorId"), value: current.actor_id || missing },
    { label: t("audit.timeline.accessType"), value: accessLabel(current.access_type, t) },
    { label: t("audit.timeline.apiKey"), value: current.api_key_id || missing },
    ...(recordedAccess.apiKeyId
      ? [{ label: t("audit.timeline.recordedApiKey"), value: recordedAccess.apiKeyId }]
      : []),
    { label: t("audit.timeline.session"), value: current.session_id || missing },
    ...(recordedAccess.sessionId
      ? [{ label: t("audit.timeline.recordedSession"), value: recordedAccess.sessionId }]
      : []),
    { label: t("audit.timeline.oauthClient"), value: current.oauth_client_id || missing },
    {
      label: t("audit.timeline.credentialOrigin"),
      value:
        current.credential_origin === "cli_oauth_session"
          ? t("audit.timeline.credentialOrigin.cliOAuthSession")
          : missing,
    },
    { label: t("audit.timeline.execution"), value: current.execution_id || missing },
    { label: t("audit.timeline.conversation"), value: current.conversation_id || missing },
    { label: t("audit.timeline.workflow"), value: current.workflow_id || missing },
    {
      label: t("audit.timeline.resourceType"),
      value: auditResourceLabel(current.resource_type, t).text,
    },
    { label: t("audit.timeline.resourceId"), value: current.resource_id || missing },
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
    { label: t("audit.timeline.trace"), value: current.trace_id || missing },
    { label: t("audit.timeline.operation"), value: current.correlation_id || missing },
    {
      label: t("audit.timeline.changedFields"),
      value: current.changed_fields?.length ? current.changed_fields.join(", ") : missing,
    },
  ];
  return (
    <div className="space-y-5" data-testid="audit-detail-facts">
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
        className={`rounded-lg border p-4 ${current.result === "denied" || current.result === "error" ? "border-destructive/30 bg-destructive/5 text-destructive" : "border-emerald-300 bg-emerald-50 text-emerald-800 dark:bg-emerald-950"}`}
      >
        <div className="text-sm font-semibold">{auditResultLabel(current.result, t).text}</div>
        <div className="mt-1 text-xs">{actionLabel(current.action, t)}</div>
      </div>
      <section className="rounded-lg border p-4" data-testid="audit-change-summary">
        <SectionHeading className="mb-3 text-sm font-semibold">
          {t("audit.timeline.changeSummary")}
        </SectionHeading>
        {current.changes?.length ? (
          <div className="space-y-3">
            {current.changes.map((change) => (
              <div key={change.field} className="border-t pt-2 text-xs">
                <div className="font-medium" title={change.field}>
                  {changeFieldLabel(change.field, t)}
                </div>
                <div className="mt-1 grid gap-2 sm:grid-cols-2">
                  <div>
                    <span className="text-muted-foreground">
                      {t("audit.timeline.beforeValue")}:{" "}
                    </span>
                    {change.before === null
                      ? t("audit.timeline.emptyValue")
                      : String(change.before)}
                  </div>
                  <div>
                    <span className="text-muted-foreground">
                      {t("audit.timeline.afterValue")}:{" "}
                    </span>
                    {change.after === null ? t("audit.timeline.emptyValue") : String(change.after)}
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
        items={facts.map((fact) => ({
          label: fact.label,
          value: <span className="break-all">{fact.value}</span>,
        }))}
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
  const names = useNameIndex(session.permissions, allowed);
  const live = useLiveQueryOptions();
  const liveStatus = useLiveStatus();
  const readable = canReadDirectory(session);
  const people = useQuery({
    queryKey: ["audit-directory", "people"],
    enabled: allowed && readable,
    queryFn: () =>
      apiRequest<{ items?: Array<{ id: string; email?: string; name?: string }> }>(
        "/v1/identity/users?limit=200",
      ),
    ...live,
  });
  const accounts = useQuery({
    queryKey: ["audit-directory", "system-accounts"],
    enabled: allowed && readable,
    queryFn: () =>
      apiRequest<{ items?: Array<{ id: string; name?: string }> }>("/v1/identity/system-accounts"),
    ...live,
  });
  const directory = useMemo(
    () => actorDirectory(people.data, accounts.data),
    [people.data, accounts.data],
  );
  const identities = useMemo<IdentityOption[]>(
    () => [
      ...(people.data?.items ?? []).map((item) => ({
        kind: "user" as const,
        id: item.id,
        label: item.name || item.email || item.id,
      })),
      ...(accounts.data?.items ?? []).map((item) => ({
        kind: "system_account" as const,
        id: item.id,
        label: item.name || item.id,
      })),
    ],
    [people.data, accounts.data],
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
    if (!allowed || invalidAppliedCorrelation || liveStatus.status === "live") return;
    const timer = window.setInterval(() => void list.query.refetch(), 60_000);
    return () => window.clearInterval(timer);
  }, [allowed, invalidAppliedCorrelation, liveStatus.status, list.query.refetch]);
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
    queryFn: () => apiRequest<TimelineEntry>(`/v1/audit-log/${encodeURIComponent(selectedId!)}`),
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
      (draft.resourceType && UUID.test(draft.resourceQuery.trim())
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
      ].some((id) => id && !UUID.test(id))
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
  const permission = current ? resourcePermission(current.resource_type) : null;
  const href =
    current && permission && session.permissions.includes(permission)
      ? auditResourceHref(current.resource_type, current.resource_id)
      : null;
  if (!allowed || forbidden)
    return (
      <Page
        kind="list"
        surface="audit"
        testId="resource-audit"
        scroll="page"
        header={<PageHeader title={t("nav.audit")} />}
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
      header={<PageHeader title={t("nav.audit")} />}
    >
      <div
        className="flex min-h-0 min-w-0 flex-1 overflow-hidden border-t"
        data-testid="audit-workspace"
      >
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
          <div className="flex shrink-0 items-center gap-3 border-b px-4 py-2 min-[1600px]:hidden">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setFilterOpen(true)}
              data-testid="audit-filter-open"
            >
              <Filter className="size-4" />
              {t("audit.timeline.filters")}
            </Button>
            <span className="truncate text-xs text-muted-foreground">
              <CalendarDays className="mr-1 inline size-3" />
              {zone}
            </span>
          </div>
          <TimelineGroupingTabs
            value={group}
            onChange={(value) => setGroup(value as AuditGroup)}
            options={AUDIT_GROUPS.map((value) => ({ value, label: t(GROUP_KEYS[value]) }))}
          />
          <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 text-xs text-muted-foreground sm:px-6">
            <span>{t("audit.timeline.loadedOnly")}</span>
            <span aria-hidden>·</span>
            <span>{zone}</span>
            <span aria-hidden>·</span>
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
            className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6"
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
                <div className="space-y-7">
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
                        directory,
                        t,
                        names,
                      )}
                    >
                      <span
                        aria-hidden
                        className="absolute -left-[9px] top-0 size-4 rounded-full border-[3px] border-background bg-slate-400"
                      />
                      <SectionHeading className="mb-4 pl-6 text-sm font-semibold text-muted-foreground sm:pl-8">
                        {groupLabel(
                          bucket.key,
                          group,
                          bucket.entries[0]!,
                          zone,
                          locale,
                          directory,
                          t,
                          names,
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
                          directory={directory}
                          names={names}
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
              directory={directory}
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
