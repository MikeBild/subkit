import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { apiCall } from "@/api/call";
import { Button, SectionHeading } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { ACCESS_TYPES, type FilterState, SOURCES } from "./audit-filter-state";
import { ACCESS_KEYS, SOURCE_KEYS } from "./audit-labels";
import { auditResourceLabel, auditResultLabel } from "./audit-model";
import {
  type IdentityOption,
  utcChoicesForLocalInput,
  validAuditCorrelationId,
} from "./audit-timeline-model";

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
type DraftSetter = React.Dispatch<React.SetStateAction<FilterState>>;
function setDraftField(setDraft: DraftSetter, key: keyof FilterState, value: string) {
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
}
export function FocusFields({
  draft,
  setDraft,
  zone,
  compact = false,
}: {
  draft: FilterState;
  setDraft: DraftSetter;
  zone: string;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const set = (key: keyof FilterState, value: string) => setDraftField(setDraft, key, value);
  const fromChoices = draft.from ? utcChoicesForLocalInput(draft.from, zone) : [];
  const toChoices = draft.to ? utcChoicesForLocalInput(draft.to, zone) : [];
  const resourceSearch = useDebouncedValue(draft.resourceQuery);
  const resources = useQuery({
    queryKey: ["audit-resource-search", resourceSearch],
    enabled: resourceSearch.trim().length >= 2,
    queryFn: () =>
      apiCall("get", "/v1/audit-log/resources", { query: { search: resourceSearch.trim() } }),
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
  const testPrefix = compact ? "audit-quick" : "audit";
  return (
    <div className="space-y-3">
      <Field label={t("audit.timeline.resourceId")}>
        <div className="relative">
          <Search aria-hidden className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
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
            data-testid={`${testPrefix}-resource-search`}
          />
        </div>
      </Field>
      {!draft.resourceId && resources.data?.items?.length ? (
        <div
          className="max-h-40 overflow-y-auto rounded-md border"
          data-testid={`${testPrefix}-resource-suggestions`}
        >
          {resources.data.items.map((item) => (
            <button
              type="button"
              data-testid={`${testPrefix}-resource-suggestion`}
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
      <div className={compact ? "grid gap-3 min-[420px]:grid-cols-2" : "space-y-3"}>
        <Field label={`${t("audit.timeline.from")} · ${zone}`}>
          <input
            type="datetime-local"
            className={inputClass}
            value={draft.from}
            onChange={(event) => set("from", event.target.value)}
            data-testid={`${testPrefix}-from`}
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
            data-testid={`${testPrefix}-to`}
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
    </div>
  );
}
export function FilterForm({
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
  const set = (key: keyof FilterState, value: string) => setDraftField(setDraft, key, value);
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
        <FocusFields draft={draft} setDraft={setDraft} zone={zone} />
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
                    if (!event.target.value) {
                      setDraft((current) => ({ ...current, actorType: "", actorId: "" }));
                      return;
                    }
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
