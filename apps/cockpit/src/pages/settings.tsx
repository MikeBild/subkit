import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { cn } from "@ui/lib/utils";
import { RotateCw } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { apiCall } from "@/api/call";
import { ApiError } from "@/api/client";
import { absolute, settingsHref } from "@/app/links";
import { useLiveQueryOptions } from "@/app/live-events";
import { useSession, useSessionUpdate } from "@/app/session";
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
  TopPageHeader,
} from "@/components/cockpit/patterns";
import { LoadFailed, queryView } from "@/components/failure-state";
import { PeopleArea } from "@/features/admin";
import { SaveNotesSwitch } from "@/features/notes";
import type { BrandingDraftHandle, GuidedContext } from "@/features/settings";
import {
  AiArea,
  AreaList,
  applySettingsPatch,
  areaStatus,
  changedSettings,
  cockpitSettings,
  DevicesArea,
  ENGINE_AREA_IDS,
  type EngineAreaId,
  engineSettingsAccess,
  HelpArea,
  isPersonalArea,
  LaunchAtLoginRow,
  LocalDevicesQuestion,
  modelCatalogQueryKey,
  NO_SETTING_DRAFTS,
  NotificationSettings,
  Notifications,
  nextSettingsSave,
  openSettingsLevel,
  PackagesSettings,
  type PersonalDrafts,
  PersonalSaveError,
  PrivacyPanel,
  ProfileArea,
  pageScope,
  personalChanges,
  personalRefusal,
  profileStatus,
  RESTART_STATUS_QUERY_KEY,
  RulesArea,
  restartOfferAfterSave,
  restartSaveNote,
  type ScopedArea,
  type SettingAreaId,
  type SettingDraftScope,
  SettingField,
  type SettingItem,
  SettingsAreaFrame,
  SettingsAttentionLine,
  type SettingsFilter,
  type SettingsLevel,
  SettingsReadOnlyNotice,
  type SettingsResponse,
  SettingsRestartDialog,
  SettingsRestartOffer,
  SettingsSaveBar,
  SettingsSection,
  SettingsSectionNav,
  SettingsSummary,
  SetupSection,
  StartLayoutRows,
  scopedAreaOf,
  settingAreaOf,
  settingDraftError,
  settingIsChanged,
  settingLeafTarget,
  settingNavigation,
  settingSecretName,
  settingSectionLabel,
  settingSectionOf,
  settingsAttention,
  settingsGuidedErrors,
  settingsLevelFromUrl,
  settingsPatches,
  settingsReadQuery,
  settingsSaveFailure,
  settingsSaveReason,
  settingsViewFromUrl,
  settleSettings,
  UpdatesPanel,
  UsageNote,
  useDesktopSettings,
  useNotificationActions,
  useRestartOffer,
  useSettingsDrafts,
  visibleSettingAreas,
  WorkspaceAiArea,
  WorkspaceArea,
  workspaceAiEditable,
  workspaceAiStatus,
} from "@/features/settings";
import { SpendSettings } from "@/features/usage";
import { VaultArea } from "@/features/vault";
import { PreparedChanges } from "@/features/workflows";
import { reportFailure } from "@/lib/action-failure";
import { useI18n } from "@/lib/i18n-context";

const SYSTEM_TENANT_ID = "00000000-0000-0000-0000-000000000000";

const SETTINGS_QUERY_KEY = ["admin", "settings"] as const;

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

function NotificationRules() {
  const { t } = useI18n();
  return (
    <section className="grid gap-3" data-testid="settings-notification-rules">
      <SectionHeading className="text-base font-semibold">
        {t("settings.question.notifications.rules")}
      </SectionHeading>
      <NotificationsBlock />
    </section>
  );
}

function stringItem(items: readonly SettingItem[], path: string): string {
  const value = items.find((item) => item.path === path)?.value;
  return typeof value === "string" ? value : "";
}

export function SettingsPage() {
  const { t } = useI18n();
  const session = useSession();
  const sessionUpdate = useSessionUpdate();
  const client = useQueryClient();
  const router = useRouter();
  const searchStr = useRouterState({ select: (state) => state.location.searchStr });
  const { permissions } = session;
  const isOwner = session.principal.is_owner;
  const origin = session.tenant.origin;
  const access = useMemo(() => ({ permissions, isOwner, origin }), [permissions, isOwner, origin]);
  const engine = engineSettingsAccess(access);
  const engineShown = engine !== "none";
  const workspaceAi = workspaceAiEditable(access);
  const desktop = useDesktopSettings();
  const onDesktop = desktop !== null;
  const areas = useMemo(() => visibleSettingAreas(access, onDesktop), [access, onDesktop]);
  const level = useMemo<SettingsLevel>(
    () => openSettingsLevel(settingsLevelFromUrl(searchStr), access, onDesktop),
    [searchStr, access, onDesktop],
  );
  const canWrite = engine === "write";
  const canReadEngine = engineShown && permissions.includes("settings:read:global");
  const [personal, setPersonal] = useState<PersonalDrafts>({});
  const [branding, setBranding] = useState<BrandingDraftHandle | null>(null);
  const personalChange = useMemo(() => personalChanges(session, personal), [session, personal]);
  const tenantId = session.tenant.id;
  const scopeAvailable = canWrite && canReadEngine && tenantId !== SYSTEM_TENANT_ID;
  const [areaScopes, setAreaScopes] = useState<Partial<Record<ScopedArea, SettingDraftScope>>>({});
  const scopedArea = scopedAreaOf(level);
  const tenantReadable = canReadEngine && tenantId !== SYSTEM_TENANT_ID;
  const [conflict, setConflict] = useState(false);
  const [failed, setFailed] = useState<{ reason: string | null } | null>(null);
  const [restartOpen, setRestartOpen] = useState(false);
  const [restartNowOpen, setRestartNowOpen] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const restartNow = useRestartOffer();
  const live = useLiveQueryOptions();
  const query = useQuery({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: () => apiCall("get", "/v1/settings", {}),
    enabled: engineShown,
    ...live,
  });
  const tenantQuery = useQuery({
    queryKey: [...SETTINGS_QUERY_KEY, "tenant", tenantId],
    queryFn: () => apiCall("get", "/v1/settings", { query: { tenant: tenantId } }),
    enabled: tenantReadable,
    ...live,
  });
  const globalItems = cockpitSettings(query.data?.items ?? []);
  const tenantItems =
    tenantReadable && tenantQuery.data ? cockpitSettings(tenantQuery.data.items) : null;
  const effectiveItems = tenantItems ?? globalItems;
  const scope: SettingDraftScope = pageScope(level, scopeAvailable, areaScopes, tenantItems);
  const viewItems =
    scope === "tenant" && tenantItems
      ? tenantItems
      : level.kind === "area" && !scopedArea
        ? effectiveItems
        : globalItems;
  const catalogTenant = scope === "tenant" ? tenantId : null;
  const catalog = useQuery({
    queryKey: modelCatalogQueryKey(catalogTenant),
    queryFn: () =>
      apiCall("get", "/v1/settings/catalog/models", {
        query: catalogTenant ? { tenant: catalogTenant } : {},
      }),
    enabled: engineShown,
  });
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
        ...personalChange.invalid.map((field) => `personal:${field}`),
      ]).size,
    [changed, globalItems, tenantItems, pending, personalChange],
  );
  const draftCount = changed.length + personalChange.count + (branding ? 1 : 0);
  const attention = settingsAttention(query.data);
  const restartItems = savingNow.filter((entry) => entry.item.meta.requiresRestart);
  const saveOffer = restartOfferAfterSave(
    restartNow.offer,
    draftState.drafts.global["server.restart_supervised"],
  );
  const publicBaseUrl =
    draftState.drafts.global["server.public_base_url"] ??
    (stringItem(query.data?.items ?? [], "server.public_base_url") ||
      (globalThis.location?.origin ?? ""));
  useDirtyGuard(changed.length > 0 || personalChange.count > 0);

  async function savePersonal(): Promise<void> {
    try {
      if (personalChange.ai) {
        const aiAccess = await apiCall("patch", "/v1/identity/workspace/ai-access", {
          body: personalChange.ai,
        });
        sessionUpdate.patch((current) => ({ ...current, ai_access: aiAccess }));
        setPersonal(({ aiProvider: _provider, aiKey: _key, aiModel: _model, ...rest }) => rest);
        await client.invalidateQueries({ queryKey: ["attention"] });
      }
      if (personalChange.profile) {
        const profile = await apiCall("patch", "/v1/identity/me", { body: personalChange.profile });
        sessionUpdate.patch((current) => ({
          ...current,
          principal: { ...current.principal, display_name: profile.display_name },
        }));
        setPersonal(({ name: _saved, ...rest }) => rest);
      }
      if (personalChange.workspace) {
        const workspace = await apiCall("patch", "/v1/identity/workspace", {
          body: personalChange.workspace,
        });
        sessionUpdate.patch((current) => ({
          ...current,
          tenant: {
            ...current.tenant,
            display_name: workspace.display_name,
            timezone: workspace.timezone,
            language: workspace.language,
          },
        }));
        setPersonal(
          ({ workspaceName: _name, timezone: _zone, language: _language, ...rest }) => rest,
        );
        await Promise.all([
          sessionUpdate.refresh(),
          client.invalidateQueries({ queryKey: ["identity-memberships"] }),
        ]);
      }
    } catch (error) {
      throw new PersonalSaveError(error instanceof ApiError ? personalRefusal(error) : null);
    }
    if (branding) await branding.save().catch(() => Promise.reject(new PersonalSaveError(null)));
  }

  const save = useMutation({
    mutationFn: async () => {
      await savePersonal();
      if (savingNow.length === 0) return null;
      if (!query.data) throw new Error("settings are not loaded");
      const patchTenant = scopeAvailable ? tenantId : null;
      const references: Record<SettingDraftScope, Record<string, string>> = {
        global: {},
        tenant: {},
      };
      for (const entry of savingNow.filter((candidate) => candidate.item.meta.sensitive)) {
        const target = entry.scope === "tenant" ? patchTenant : null;
        const created = await apiCall("post", "/v1/secrets/{name}/versions", {
          path: { name: settingSecretName(entry.item.path, target) },
          body: { value: entry.text },
        });
        references[entry.scope][entry.item.path] = created.reference;
      }
      const scoped = { ...NO_SETTING_DRAFTS, [savingScope]: pending[savingScope] };
      const next = nextSettingsSave(settingsPatches(query.data, scoped, references, patchTenant));
      if (next) {
        await applySettingsPatch(next.patch);
        const fresh = await settleSettings(
          () => apiCall("get", "/v1/settings", { query: settingsReadQuery(next.patch) }),
          next.patch.changes,
        );
        if (fresh)
          client.setQueryData(
            next.patch.scope === "tenant"
              ? [...SETTINGS_QUERY_KEY, "tenant", tenantId]
              : SETTINGS_QUERY_KEY,
            fresh,
          );
      }
      return savingScope;
    },
    onSuccess: async (saved) => {
      if (saved) {
        await Promise.all([
          client.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY }),
          client.invalidateQueries({ queryKey: RESTART_STATUS_QUERY_KEY }),
          client.invalidateQueries({ queryKey: ["usage-status"] }),
        ]);
        draftState.clear(saved);
      }
      setConflict(false);
      setFailed(null);
      setRestartOpen(false);
      setFormKey((key) => key + 1);
      toast.success(t("settings.saved"));
    },
    onError: (error) => {
      setRestartOpen(false);
      if (error instanceof PersonalSaveError) {
        const reason = error.reason ? t(error.reason) : null;
        setFailed({ reason });
        reportFailure(reason ?? t("settings.saveFailedKeep"), error);
        return;
      }
      void client.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
      if (settingsSaveFailure(error) === "conflict") setConflict(true);
      else {
        const reason = settingsSaveReason(error);
        setFailed({ reason });
        reportFailure(
          reason ? t("settings.saveRejected", { reason }) : t("settings.saveFailedKeep"),
          error,
        );
      }
    },
  });

  function navigate(href: string) {
    router.history.push(absolute(href));
  }

  function editPersonal(change: PersonalDrafts) {
    setFailed(null);
    setPersonal((current) => ({ ...current, ...change }));
  }

  function setDraft(path: string, text: string, requested: SettingDraftScope) {
    setFailed(null);
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
    effectiveItems,
    drafts: draftState.texts(viewItems, scope),
    canWrite,
    pending: save.isPending,
    scope,
    scopeAvailable: scopeAvailable && scopedArea !== null,
    catalog: catalog.data,
    publicBaseUrl,
    setDraft: (path, text) => setDraft(path, text, scope),
    dropDraft: (path) => draftState.dropDraft(path, scope),
    onScope: (next) => {
      if (scopedArea) setAreaScopes((current) => ({ ...current, [scopedArea]: next }));
    },
    navigate,
  };

  const pendingRestart = query.data?.pending_restart_fields ?? [];
  const facts = {
    items: effectiveItems,
    pendingRestart,
  };
  const view = engineShown ? queryView(query, () => false) : "ready";
  const engineReady = engineShown && view === "ready";
  const personalArea = level.kind === "area" && isPersonalArea(level.area) ? level.area : null;
  const profileMark = profileStatus(session);
  const workspaceAiMark = workspaceAi ? workspaceAiStatus(session) : null;
  const drafted = new Set<SettingAreaId>([
    ...changed.map((entry) => settingAreaOf(entry.item.path)),
    ...personalChange.areas,
    ...(branding ? (["workspace"] as const) : []),
  ]);
  const marked = new Set<SettingAreaId>([
    ...(profileMark ? (["profile"] as const) : []),
    ...(workspaceAiMark ? (["ai"] as const) : []),
    ...(engineReady
      ? ENGINE_AREA_IDS.filter((area) => {
          const state = areaStatus(area, facts);
          return state === "waiting" || state === "restart";
        })
      : []),
  ]);
  const frame = (area: SettingAreaId, children: ReactNode) => (
    <SettingsAreaFrame
      area={area}
      areas={areas}
      expert={engineShown}
      drafted={drafted}
      attention={marked}
      onNavigate={navigate}
    >
      {area === "notifications" ? (
        <Notifications
          terminal={engineShown ? { tenant: session.tenant.id, canWrite } : null}
          more={children}
        />
      ) : (
        children
      )}
    </SettingsAreaFrame>
  );
  const all = level.kind === "all";
  const header = all ? (
    <PageHeader
      title={t("settings.all.title")}
      back={{ to: settingsHref(), label: t("settings.level.simple") }}
      purpose={`${t("settings.all.purpose")} ${t("settings.all.hint")}`}
    />
  ) : (
    <TopPageHeader title={t("nav.settings")} />
  );

  return (
    <Page kind="settings" scroll="page" testId="admin-settings" header={header}>
      <div className={cn("grid gap-4 pb-20", !all && "pt-6")} data-testid="settings-system">
        {canReadEngine && (level.kind === "all" || !personalArea) ? (
          <PreparedChanges canDecide={canWrite} />
        ) : null}
        {personalArea === "profile" ? (
          frame(
            "profile",
            <ProfileArea
              name={personal.name ?? session.principal.display_name ?? ""}
              nameInvalid={personalChange.invalid.includes("name")}
              onName={(name) => editPersonal({ name })}
              disabled={save.isPending}
              navigate={navigate}
              extra={
                <>
                  <LaunchAtLoginRow control={desktop} />
                  <StartLayoutRows />
                  <SaveNotesSwitch />
                </>
              }
            />,
          )
        ) : personalArea === "setup" ? (
          frame("setup", <SetupSection />)
        ) : personalArea === "people" ? (
          frame("people", <PeopleArea />)
        ) : personalArea === "devices" ? (
          frame(
            "devices",
            <>
              <DevicesArea />
              <LocalDevicesQuestion />
            </>,
          )
        ) : personalArea === "updates" && desktop ? (
          frame("updates", <UpdatesPanel control={desktop} />)
        ) : personalArea === "privacy" && desktop ? (
          frame("privacy", <PrivacyPanel control={desktop} />)
        ) : personalArea === "help" ? (
          frame("help", <HelpArea />)
        ) : personalArea === "rules" ? (
          frame("rules", <RulesArea />)
        ) : personalArea === "vault" ? (
          frame("vault", <VaultArea />)
        ) : personalArea === "usage" ? (
          frame("usage", <SpendSettings />)
        ) : personalArea === "workspace" ? (
          frame(
            "workspace",
            <WorkspaceArea
              name={personal.workspaceName ?? session.tenant.display_name}
              nameInvalid={personalChange.invalid.includes("workspaceName")}
              onName={(workspaceName) => editPersonal({ workspaceName })}
              timezone={personal.timezone ?? session.tenant.timezone}
              onTimezone={(timezone) => editPersonal({ timezone })}
              language={personal.language ?? session.tenant.language}
              onLanguage={(language) => editPersonal({ language })}
              disabled={save.isPending}
              onBrandingDraft={setBranding}
            />,
          )
        ) : workspaceAi && level.kind === "area" && level.area === "ai" ? (
          frame(
            "ai",
            <WorkspaceAiArea
              drafts={personal}
              keyInvalid={personalChange.invalid.includes("aiKey")}
              disabled={save.isPending}
              onChange={editPersonal}
            />,
          )
        ) : !engineShown ? (
          frame("notifications", <NotificationRules />)
        ) : view === "loading" ? (
          <DataState state="loading" testId="settings-loading" />
        ) : view === "error" ? (
          <LoadFailed
            title={t("resource.loadFailed", { resource: t("resource.settings.title") })}
            onRetry={() => void query.refetch()}
            error={query.error}
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
          frame(
            level.area,
            <>
              <SettingsReadOnlyNotice canWrite={canWrite} ask />
              <GuidedArea
                key={`${level.area}-${formKey}`}
                area={level.area as EngineAreaId}
                ctx={ctx}
                restart={
                  pendingRestart.length > 0 && restartNow.offer === "restart" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="self-start"
                      onClick={() => setRestartNowOpen(true)}
                      data-testid="settings-operations-restart"
                    >
                      <RotateCw data-icon="inline-start" />
                      {t("settings.restartNow.button")}
                    </Button>
                  ) : null
                }
              />
            </>,
          )
        )}
      </div>
      {draftCount > 0 || (canWrite && conflict) ? (
        <SettingsSaveBar
          count={draftCount}
          conflict={conflict}
          failed={failed !== null}
          reason={failed?.reason}
          pending={save.isPending}
          invalid={invalidCount > 0}
          invalidCount={invalidCount}
          firstOf={mixed ? savingNow.length : undefined}
          onDiscard={() => {
            draftState.clear();
            setPersonal({});
            branding?.discard();
            setFormKey((key) => key + 1);
            setConflict(false);
            setFailed(null);
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
    </Page>
  );
}

function GuidedArea({
  area,
  ctx,
  restart,
}: {
  area: EngineAreaId;
  ctx: GuidedContext;
  restart: ReactNode;
}) {
  const session = useSession();
  if (area === "ai")
    return (
      <div className="grid gap-5">
        <AiArea ctx={ctx} />
        {session.permissions.includes("stats:read") ? <UsageNote /> : null}
      </div>
    );
  if (area === "notifications")
    return (
      <AreaList
        area="notifications"
        ctx={ctx}
        after={session.permissions.includes("notification:read") ? <NotificationRules /> : null}
      />
    );
  if (area === "operations")
    return <AreaList area="operations" ctx={ctx} before={restart} after={<PackagesSettings />} />;
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
  const nav = useMemo(
    () => settingNavigation([...new Set(allItems.map((item) => settingSectionOf(item.path)))]),
    [allItems],
  );
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
    if (window.location.pathname !== href.split(/[?#]/)[0]) return;
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
      <div className="@container/settings grid gap-5" data-testid="settings-list">
        <SettingsReadOnlyNotice canWrite={canWrite} />
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
