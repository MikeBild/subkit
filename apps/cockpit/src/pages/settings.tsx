import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { RotateCw } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { apiRequest } from "@/api/client";
import { absolute, settingsHref } from "@/app/links";
import { useLiveQueryOptions } from "@/app/live-events";
import { useSession } from "@/app/session";
import { useDirtyGuard } from "@/app/version-notice";
import {
  Button,
  ConfirmDialog,
  DataState,
  Page,
  PageHeader,
  SectionHeading,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/cockpit/patterns";
import { PreparedChanges } from "@/components/cockpit/prepared-changes";
import { WorkspaceDeletion } from "@/components/cockpit/workspace-deletion";
import { ForbiddenState, LoadFailed, queryView } from "@/components/failure-state";
import { useI18n } from "@/lib/i18n-context";
import { NotificationSettings, useNotificationActions } from "@/pages/notification-settings";
import { canReadOperations } from "@/pages/operations-bar";
import { STATUS_ENDPOINT } from "@/pages/operations-figures";
import { AiArea, providerName } from "@/pages/settings-ai";
import { AreaList } from "@/pages/settings-area-list";
import {
  areaSentences,
  areaStatus,
  pageScope,
  type ScopedArea,
  SETTING_AREA_IDS,
  type SettingAreaId,
  type SettingsLevel,
  scopedAreaOf,
  settingAreaOf,
  settingsGuidedErrors,
  settingsLevelFromUrl,
} from "@/pages/settings-areas";
import {
  catalogModelName,
  type ModelCatalog,
  modelCatalogEndpoint,
  modelCatalogQueryKey,
} from "@/pages/settings-catalog";
import { CostsArea } from "@/pages/settings-costs";
import { useSettingsDrafts } from "@/pages/settings-drafts";
import type { GuidedContext } from "@/pages/settings-guided";
import {
  changedSettings,
  NO_SETTING_DRAFTS,
  nextSettingsSave,
  type SettingDraftScope,
  type SettingItem,
  type SettingsFilter,
  type SettingsResponse,
  settingDraftError,
  settingIsChanged,
  settingLeafTarget,
  settingNavigation,
  settingSecretName,
  settingSectionLabel,
  settingSectionOf,
  settingsAttention,
  settingsPatches,
  settingsSaveFailure,
  settingsViewFromUrl,
} from "@/pages/settings-model";
import { type AreaCard, SettingsAreaFrame, SettingsOverview } from "@/pages/settings-overview";
import {
  RESTART_STATUS_QUERY_KEY,
  SettingsRestartDialog,
  SettingsRestartOffer,
  useRestartOffer,
} from "@/pages/settings-restart";
import { restartOfferAfterSave, restartSaveNote } from "@/pages/settings-restart-model";
import {
  SettingField,
  SettingsAttentionLine,
  SettingsReadOnlyNotice,
  SettingsSaveBar,
  SettingsSection,
  SettingsSectionNav,
  SettingsSummary,
} from "@/pages/settings-rows";
import { applySettingsPatch } from "@/pages/settings-save";
import { type BudgetSummary, budgetSummary } from "@/pages/usage-model";
import { BrandingSettings } from "./branding";

export * from "@/pages/settings-rows";

const SYSTEM_TENANT_ID = "00000000-0000-0000-0000-000000000000";

export function rememberHostedModels(
  current: readonly unknown[],
  seen: readonly unknown[],
): readonly unknown[] {
  const modelOf = (entry: unknown) =>
    entry && typeof entry === "object" && typeof (entry as { model?: unknown }).model === "string"
      ? (entry as { model: string }).model
      : null;
  const known = new Set(current.map(modelOf));
  const added = seen.filter((entry) => {
    const model = modelOf(entry);
    return model !== null && !known.has(model);
  });
  return added.length > 0 ? [...current, ...added] : current;
}
const SETTINGS_QUERY_KEY = ["admin", "settings"] as const;

export function SettingsPage() {
  const { t } = useI18n();
  const session = useSession();
  if (session.permissions.includes("settings:read")) return <SettingsWorkspace />;
  return (
    <Page
      kind="settings"
      scroll="page"
      testId="admin-settings"
      header={<PageHeader title={t("resource.settings.title")} />}
    >
      {session.permissions.includes("notification:read") ? (
        <NotificationsOnly />
      ) : (
        <ForbiddenState />
      )}
      {session.identity_memberships ? <WorkspaceDeletion /> : null}
    </Page>
  );
}

function NotificationsBlock() {
  const [createRule, setCreateRule] = useState(false);
  const [createChannel, setCreateChannel] = useState(false);
  const actions = useNotificationActions({
    onCreateRule: () => setCreateRule(true),
    onCreateChannel: () => setCreateChannel(true),
    outline: true,
  });
  return (
    <div className="grid gap-3">
      {actions.action || actions.secondary ? (
        <div className="flex flex-wrap gap-2">
          {actions.action}
          {actions.secondary}
        </div>
      ) : null}
      <NotificationSettings
        createRule={createRule}
        onCreateRule={setCreateRule}
        createChannel={createChannel}
        onCreateChannel={setCreateChannel}
      />
    </div>
  );
}

function NotificationsOnly() {
  return <NotificationsBlock />;
}

function stringItem(items: readonly SettingItem[], path: string): string {
  const value = items.find((item) => item.path === path)?.value;
  return typeof value === "string" ? value : "";
}

function nextMonthStart(locale: string): string {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return new Intl.DateTimeFormat(locale === "de" ? "de-DE" : "en-US", {
    day: "numeric",
    month: "long",
  }).format(first);
}

function SettingsWorkspace() {
  const { t, locale } = useI18n();
  const session = useSession();
  const client = useQueryClient();
  const router = useRouter();
  const searchStr = useRouterState({ select: (state) => state.location.searchStr });
  const level = useMemo<SettingsLevel>(() => settingsLevelFromUrl(searchStr), [searchStr]);
  const canWrite = session.permissions.includes("settings:write:global");
  const canReadEngine = session.permissions.includes("settings:read:global");
  const tenantId = session.tenant.id;
  const scopeAvailable = canWrite && canReadEngine && tenantId !== SYSTEM_TENANT_ID;
  const [areaScopes, setAreaScopes] = useState<Record<ScopedArea, SettingDraftScope>>({
    ai: "global",
    costs: "global",
  });
  const scopedArea = scopedAreaOf(level);
  const scope: SettingDraftScope = pageScope(level, scopeAvailable, areaScopes);
  const [conflict, setConflict] = useState(false);
  const [failed, setFailed] = useState(false);
  const [restartOpen, setRestartOpen] = useState(false);
  const [restartNowOpen, setRestartNowOpen] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const [rememberedHostedModels, setRememberedHostedModels] = useState<readonly unknown[]>([]);
  const restartNow = useRestartOffer();
  const live = useLiveQueryOptions();
  const query = useQuery({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: () => apiRequest<SettingsResponse>("/v1/settings"),
    ...live,
  });
  const tenantQuery = useQuery({
    queryKey: [...SETTINGS_QUERY_KEY, "tenant", tenantId],
    queryFn: () =>
      apiRequest<SettingsResponse>(`/v1/settings?tenant=${encodeURIComponent(tenantId)}`),
    enabled: scopeAvailable,
    ...live,
  });
  const catalogTenant = scope === "tenant" ? tenantId : null;
  const catalog = useQuery({
    queryKey: modelCatalogQueryKey(catalogTenant),
    queryFn: () => apiRequest<ModelCatalog>(modelCatalogEndpoint(catalogTenant)),
  });
  const statusAllowed = canReadOperations(session.permissions);
  const status = useQuery({
    queryKey: ["usage-status"],
    enabled: statusAllowed,
    queryFn: () => apiRequest<unknown>(STATUS_ENDPOINT),
  });
  const usage: BudgetSummary | null = status.data ? budgetSummary(status.data) : null;
  const globalItems = query.data?.items ?? [];
  const tenantItems = scopeAvailable ? (tenantQuery.data?.items ?? null) : null;
  const viewItems = scope === "tenant" && tenantItems ? tenantItems : globalItems;
  const draftState = useSettingsDrafts(globalItems);
  const { pending } = draftState;
  const changed = useMemo(() => changedSettings(globalItems, pending), [globalItems, pending]);
  const savingScope: SettingDraftScope = changed.some((entry) => entry.scope === "global")
    ? "global"
    : "tenant";
  const savingNow = changed.filter((entry) => entry.scope === savingScope);
  const mixed = savingNow.length > 0 && savingNow.length < changed.length;
  const invalidCount = useMemo(
    () =>
      new Set([
        ...changed
          .filter((entry) => settingDraftError(entry.item, entry.text))
          .map((entry) => `${entry.scope}:${entry.item.path}`),
        ...settingsGuidedErrors(globalItems, pending.global).map((path) => `global:${path}`),
        ...settingsGuidedErrors(tenantItems ?? globalItems, pending.tenant).map(
          (path) => `tenant:${path}`,
        ),
      ]).size,
    [changed, globalItems, tenantItems, pending],
  );
  const attention = settingsAttention(query.data);
  const restartItems = savingNow.filter((entry) => entry.item.meta.requiresRestart);
  const saveOffer = restartOfferAfterSave(
    restartNow.offer,
    draftState.drafts.global["server.restart_supervised"],
  );
  const publicBaseUrl =
    draftState.drafts.global["server.public_base_url"] ??
    (stringItem(globalItems, "server.public_base_url") || (globalThis.location?.origin ?? ""));
  useDirtyGuard(changed.length > 0);
  useEffect(() => {
    const value = globalItems.find((item) => item.path === "llm.hosted.models")?.value;
    if (!Array.isArray(value) || value.length === 0) return;
    setRememberedHostedModels((current) => rememberHostedModels(current, value));
  }, [globalItems]);

  const save = useMutation({
    mutationFn: async () => {
      if (!query.data) throw new Error("settings are not loaded");
      const patchTenant = scopeAvailable ? tenantId : null;
      const references: Record<SettingDraftScope, Record<string, string>> = {
        global: {},
        tenant: {},
      };
      for (const entry of savingNow.filter((candidate) => candidate.item.meta.sensitive)) {
        const target = entry.scope === "tenant" ? patchTenant : null;
        const created = await apiRequest<{ reference: string }>(
          `/v1/secrets/${encodeURIComponent(settingSecretName(entry.item.path, target))}/versions`,
          { method: "POST", body: JSON.stringify({ value: entry.text }) },
        );
        references[entry.scope][entry.item.path] = created.reference;
      }
      const scoped = { ...NO_SETTING_DRAFTS, [savingScope]: pending[savingScope] };
      const next = nextSettingsSave(settingsPatches(query.data, scoped, references, patchTenant));
      if (next) await applySettingsPatch(next.patch);
      return savingScope;
    },
    onSuccess: async (saved) => {
      draftState.clear(saved);
      setConflict(false);
      setFailed(false);
      setRestartOpen(false);
      await client.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
      await client.invalidateQueries({ queryKey: RESTART_STATUS_QUERY_KEY });
      setFormKey((key) => key + 1);
      toast.success(t("settings.saved"));
    },
    onError: (error) => {
      setRestartOpen(false);
      void client.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
      if (settingsSaveFailure(error) === "conflict") setConflict(true);
      else {
        setFailed(true);
        toast.error(t("settings.saveFailedKeep"));
      }
    },
  });

  function navigate(href: string) {
    router.history.push(absolute(href));
  }

  function setDraft(path: string, text: string, requested: SettingDraftScope) {
    setFailed(false);
    draftState.setDraft(path, text, requested);
  }

  function reload() {
    void query.refetch().then((result) => {
      if (!result.isError) setConflict(false);
    });
  }

  const ctx: GuidedContext = {
    items: viewItems,
    globalItems,
    tenantItems,
    drafts: draftState.texts(viewItems, scope),
    canWrite,
    pending: save.isPending,
    scope,
    scopeAvailable: scopeAvailable && scopedArea !== null,
    catalog: catalog.data,
    usage,
    publicBaseUrl,
    rememberedHostedModels,
    setDraft: (path, text) => setDraft(path, text, scope),
    dropDraft: (path) => draftState.dropDraft(path, scope),
    onScope: (next) => {
      if (scopedArea) setAreaScopes((current) => ({ ...current, [scopedArea]: next }));
    },
    navigate,
  };

  const pendingRestart = query.data?.pending_restart_fields ?? [];
  const facts = {
    items: globalItems,
    pendingRestart,
    budgetConsumedShare: usage?.consumedShare ?? null,
  };
  const view = queryView(query, () => false);
  const all = level.kind === "all";
  const header = all ? (
    <PageHeader
      title={t("settings.all.title")}
      back={{ to: settingsHref(), label: t("settings.level.simple") }}
      purpose={`${t("settings.all.purpose")} ${t("settings.all.hint")}`}
    />
  ) : (
    <PageHeader title={t("resource.settings.title")} purpose={t("settings.purpose")} />
  );

  return (
    <Page kind="settings" scroll="page" testId="admin-settings" header={header}>
      <div className="grid gap-4 pb-20" data-testid="settings-system">
        {canReadEngine && level.kind !== "area" ? <PreparedChanges canDecide={canWrite} /> : null}
        {view === "loading" ? (
          <DataState state="loading" testId="settings-loading" />
        ) : view === "error" ? (
          <LoadFailed
            title={t("resource.loadFailed", { resource: t("resource.settings.title") })}
            onRetry={() => void query.refetch()}
            testId="settings-load-failed"
          />
        ) : level.kind === "all" ? (
          <AllSettings
            key={searchStr}
            data={query.data}
            items={globalItems}
            drafts={draftState.drafts.global}
            canWrite={canWrite}
            pending={save.isPending}
            publicBaseUrl={publicBaseUrl}
            restartOffer={
              <SettingsRestartOffer
                offer={restartNow.offer}
                onRestart={() => setRestartNowOpen(true)}
              />
            }
            onDraft={(path, text) => setDraft(path, text, "global")}
            onDrop={(path) => draftState.dropDraft(path, "global")}
          />
        ) : (
          <>
            <SettingsReadOnlyNotice canWrite={canWrite} ask />
            {level.kind === "overview" ? (
              <SettingsOverview
                cards={overviewCards({
                  facts,
                  catalog: catalog.data,
                  usage,
                  canWrite,
                  locale,
                  t,
                  restartAction:
                    restartNow.offer === "restart" ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setRestartNowOpen(true)}
                        data-testid="settings-overview-restart"
                      >
                        <RotateCw data-icon="inline-start" />
                        {t("settings.restartNow.button")}
                      </Button>
                    ) : null,
                })}
                onNavigate={navigate}
              />
            ) : (
              <SettingsAreaFrame
                area={level.area}
                drafted={new Set(changed.map((entry) => settingAreaOf(entry.item.path)))}
                attention={
                  new Set(
                    SETTING_AREA_IDS.filter((area) => {
                      const state = areaStatus(area, facts);
                      return state === "waiting" || state === "restart" || state === "limit";
                    }),
                  )
                }
                onNavigate={navigate}
              >
                <GuidedArea key={`${level.area}-${formKey}`} area={level.area} ctx={ctx} />
              </SettingsAreaFrame>
            )}
          </>
        )}
      </div>
      {canWrite && (changed.length > 0 || conflict) ? (
        <SettingsSaveBar
          count={changed.length}
          conflict={conflict}
          failed={failed}
          pending={save.isPending}
          invalid={invalidCount > 0}
          invalidCount={invalidCount}
          firstOf={mixed ? savingNow.length : undefined}
          onDiscard={() => {
            draftState.clear();
            setFormKey((key) => key + 1);
            setConflict(false);
            setFailed(false);
          }}
          onReload={reload}
          onSave={() => (restartItems.length > 0 ? setRestartOpen(true) : save.mutate())}
        />
      ) : null}
      <ConfirmDialog
        open={restartOpen}
        onOpenChange={(open) => !open && setRestartOpen(false)}
        object={t("settings.restartSave.object")}
        verb={t("common.save")}
        consequence={t(restartSaveNote(saveOffer))}
        pending={save.isPending}
        onConfirm={() => save.mutate()}
        testId="settings-restart-dialog"
      />
      {restartNow.offer === "restart" ? (
        <SettingsRestartDialog
          open={restartNowOpen}
          onOpenChange={setRestartNowOpen}
          pendingFields={attention?.restart ?? restartNow.status?.pending_restart_fields ?? []}
        />
      ) : null}
      {session.identity_memberships ? <WorkspaceDeletion /> : null}
    </Page>
  );
}

export function overviewCards({
  facts,
  catalog,
  usage,
  canWrite,
  locale,
  t,
  restartAction,
}: {
  facts: {
    items: readonly SettingItem[];
    pendingRestart: readonly string[];
    budgetConsumedShare: number | null;
  };
  catalog: ModelCatalog | undefined;
  usage: BudgetSummary | null;
  canWrite: boolean;
  locale: string;
  t: ReturnType<typeof useI18n>["t"];
  restartAction: ReactNode;
}): AreaCard[] {
  const number = new Intl.NumberFormat(locale === "de" ? "de-DE" : "en-US");
  const tokens = (count: number) => t("settings.costs.tokens", { count: number.format(count) });
  return SETTING_AREA_IDS.map((id) => {
    const sentences = areaSentences(id, {
      ...facts,
      canWrite,
      providerName: (provider) => providerName(provider, t),
      modelName: (provider, model) =>
        catalogModelName(catalog, model) ??
        (model || t("settings.ai.model.default", { provider: providerName(provider, t) })),
      budgetText: tokens,
      spentText: usage && usage.usedTokens !== null ? tokens(usage.usedTokens) : null,
      resetDate: nextMonthStart(locale),
      apiKeyName: t("settings.overview.access.apiKey"),
    });
    return {
      id,
      sentence: sentences.map((sentence) => t(sentence.key, sentence.values)).join(" "),
      status: areaStatus(id, facts),
      action: id === "operations" && facts.pendingRestart.length > 0 ? restartAction : undefined,
    };
  });
}

function GuidedArea({ area, ctx }: { area: SettingAreaId; ctx: GuidedContext }) {
  const { t } = useI18n();
  const session = useSession();
  if (area === "ai") return <AiArea ctx={ctx} />;
  if (area === "costs") return <CostsArea ctx={ctx} />;
  if (area === "notifications")
    return (
      <AreaList
        area="notifications"
        ctx={ctx}
        after={
          session.permissions.includes("notification:read") ? (
            <section className="grid gap-3" data-testid="settings-notification-rules">
              <SectionHeading className="text-base font-semibold">
                {t("settings.question.notifications.rules")}
              </SectionHeading>
              <NotificationsBlock />
            </section>
          ) : null
        }
      />
    );
  if (area === "operations")
    return (
      <AreaList
        area="operations"
        ctx={ctx}
        before={
          <p className="text-sm text-muted-foreground">{t("settings.question.operations.hint")}</p>
        }
        after={
          <section className="grid gap-3" data-testid="settings-branding">
            <div className="grid gap-1">
              <SectionHeading className="text-base font-semibold">
                {t("settings.question.operations.branding")}
              </SectionHeading>
              <p className="text-sm text-muted-foreground">
                {t("settings.question.operations.brandingLine")}
              </p>
            </div>
            <BrandingSettings />
          </section>
        }
      />
    );
  return <AreaList area={area} ctx={ctx} />;
}

function AllSettings({
  data,
  items: allItems,
  drafts,
  canWrite,
  pending,
  publicBaseUrl,
  restartOffer,
  onDraft,
  onDrop,
}: {
  data: SettingsResponse | undefined;
  items: readonly SettingItem[];
  drafts: Readonly<Record<string, string>>;
  canWrite: boolean;
  pending: boolean;
  publicBaseUrl: string;
  restartOffer: ReactNode;
  onDraft(path: string, text: string): void;
  onDrop(path: string): void;
}) {
  const { t } = useI18n();
  const [linked] = useState(() => settingsViewFromUrl(window.location.search));
  const [leaf, setLeaf] = useState(linked.leaf);
  const [filter, setFilter] = useState<SettingsFilter>(linked.leaf ? "all" : linked.filter);
  const [activeSection, setActiveSection] = useState(
    linked.leaf ? settingSectionOf(linked.leaf) : (linked.section ?? ""),
  );
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [leafMissing, setLeafMissing] = useState(false);
  const focused = useRef(false);
  const listMode = filter === "changed";
  const nav = useMemo(() => {
    const groups = settingNavigation([
      ...new Set(allItems.map((item) => settingSectionOf(item.path))),
    ]);
    const interfaceGroup = groups.find((group) => group.id === "sk");
    if (interfaceGroup) interfaceGroup.sections.unshift("branding");
    else groups.push({ id: "sk", label: "settings.group.sk", sections: ["branding"] });
    return groups;
  }, [allItems]);
  const orderedSections = useMemo(() => nav.flatMap((group) => group.sections), [nav]);
  const hits = useMemo(
    () => (listMode ? allItems.filter((item) => settingIsChanged(item)) : []),
    [allItems, listMode],
  );
  const hitSections = useMemo(
    () => (listMode ? new Set(hits.map((item) => settingSectionOf(item.path))) : null),
    [hits, listMode],
  );
  const draftSections = useMemo(() => new Set(Object.keys(drafts).map(settingSectionOf)), [drafts]);
  const selectedSection = orderedSections.includes(activeSection)
    ? activeSection
    : (orderedSections[0] ?? "");
  const attention = settingsAttention(data);
  const changedCount = useMemo(() => allItems.filter(settingIsChanged).length, [allItems]);
  useEffect(() => {
    const href = absolute(
      settingsHref(leaf, {
        section: leaf ? null : activeSection || null,
        filter: leaf || filter === "all" ? null : filter,
        all: true,
      }),
    );
    if (`${window.location.pathname}${window.location.search}` !== href)
      window.history.replaceState(window.history.state, "", href);
  }, [leaf, activeSection, filter]);
  useEffect(() => {
    if (focused.current || !leaf || !data) return;
    focused.current = true;
    const target = settingLeafTarget(
      allItems.map((item) => item.path),
      leaf,
    );
    if (!target) {
      setLeafMissing(true);
      return;
    }
    const index = target.index;
    setHighlighted(allItems[index]?.path ?? null);
    requestAnimationFrame(() => {
      const item = document.querySelector<HTMLElement>(`[data-testid="setting-item-${index}"]`);
      const field =
        document.getElementById(`setting-${index}`) ??
        item?.querySelector<HTMLElement>(
          '[data-slot="setting-control"] :is(input, select, textarea, button:not([data-tooltip-trigger]))',
        ) ??
        null;
      (item ?? field)?.scrollIntoView({ block: "center", inline: "nearest" });
      field?.focus({ preventScroll: true });
    });
  }, [leaf, data, allItems]);

  function openSection(section: string) {
    setLeaf(null);
    setFilter("all");
    setHighlighted(null);
    setLeafMissing(false);
    setActiveSection(section);
  }

  function openLeaf(path: string) {
    focused.current = false;
    setFilter("all");
    setLeafMissing(false);
    setActiveSection(settingSectionOf(path));
    setLeaf(path);
  }

  function renderRow(item: SettingItem) {
    return (
      <SettingField
        key={item.path}
        item={item}
        index={allItems.indexOf(item)}
        items={allItems}
        draft={drafts[item.path]}
        highlighted={highlighted === item.path}
        disabled={!canWrite || pending}
        canCopyKey={canWrite}
        publicBaseUrl={publicBaseUrl}
        onDraft={(text) => onDraft(item.path, text)}
        onDrop={() => onDrop(item.path)}
      />
    );
  }

  const sectionItems = (section: string) =>
    allItems.filter((item) => settingSectionOf(item.path) === section);

  return (
    <div className="flex flex-col gap-4" data-testid="settings-all">
      {selectedSection !== "branding" ? (
        <SettingsSummary
          total={allItems.length}
          changed={changedCount}
          filter={filter}
          onFilter={(next) => {
            setLeaf(null);
            setHighlighted(null);
            setFilter(next);
          }}
        />
      ) : null}
      <div className="@container/settings grid gap-5" data-testid="settings-list">
        {selectedSection !== "branding" ? <SettingsReadOnlyNotice canWrite={canWrite} /> : null}
        <SettingsAttentionLine
          attention={attention}
          onOpenLeaf={openLeaf}
          restartOffer={restartOffer}
        />
        {leafMissing && leaf ? (
          <p className="text-sm text-muted-foreground" data-testid="settings-leaf-missing">
            {t("settings.leafMissing", { path: leaf })}
          </p>
        ) : null}
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 @min-[720px]/settings:grid-cols-[200px_minmax(0,1fr)]">
          <div
            className="hidden min-w-0 self-start overflow-x-hidden @min-[720px]/settings:sticky @min-[720px]/settings:top-0 @min-[720px]/settings:block @min-[720px]/settings:max-h-[calc(100dvh-7rem)] @min-[720px]/settings:overflow-y-auto"
            data-testid="settings-section-list"
          >
            <SettingsSectionNav
              nav={nav}
              current={listMode ? null : selectedSection}
              hits={hitSections}
              drafts={draftSections}
              onOpen={openSection}
            />
          </div>
          <div className="@container/settings-panel min-w-0" data-testid="settings-panel">
            {listMode ? null : (
              <div className="mb-3 @min-[720px]/settings:hidden">
                <Select value={selectedSection} onValueChange={openSection}>
                  <SelectTrigger
                    className="w-full"
                    aria-label={t("settings.sections")}
                    data-testid="settings-section-picker"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {nav.map((group) => (
                      <SelectGroup key={group.id}>
                        {group.sections.map((section) => (
                          <SelectItem
                            key={section}
                            value={section}
                            data-testid={`settings-section-option-${section}`}
                          >
                            {settingSectionLabel(section, t).text}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {listMode ? (
              hits.length === 0 ? (
                <DataState
                  state="empty"
                  line={t("settings.allDefault")}
                  testId="settings-all-default"
                  action={
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setFilter("all")}
                      data-testid="settings-show-all"
                    >
                      {t("settings.showAll")}
                    </Button>
                  }
                />
              ) : (
                <div className="grid gap-8" data-testid="settings-hits">
                  {orderedSections
                    .filter((section) => hitSections?.has(section))
                    .map((section) => {
                      const sectionHits = hits.filter(
                        (item) => settingSectionOf(item.path) === section,
                      );
                      return (
                        <SettingsSection
                          key={section}
                          section={section}
                          items={sectionHits}
                          testId={`settings-hits-${section}`}
                        >
                          {sectionHits.map(renderRow)}
                        </SettingsSection>
                      );
                    })}
                </div>
              )
            ) : selectedSection === "branding" ? (
              <BrandingSettings />
            ) : (
              <SettingsSection
                section={selectedSection}
                items={sectionItems(selectedSection)}
                testId={`settings-section-${selectedSection}`}
              >
                {sectionItems(selectedSection).map(renderRow)}
              </SettingsSection>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
