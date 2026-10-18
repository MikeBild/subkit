import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, Copy, Plus, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { apiRequest } from "@/api/client";
import { absolute, auditHref, peopleHref, settingsHref } from "@/app/links";
import { useLiveQueryOptions } from "@/app/live-events";
import { useSession } from "@/app/session";
import { useDirtyGuard } from "@/app/version-notice";
import { IconButton } from "@/components/cockpit/icon-button";
import {
  Button,
  ConfirmDialog,
  ContextHelp,
  DataState,
  type Fact,
  FactList,
  Input,
  Page,
  PageHeader,
  PageTabs,
  SaveBar,
  Section,
  SegmentedControl,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SummaryLine,
  Switch,
  tabFromSearch,
  useCopy,
} from "@/components/cockpit/patterns";
import { PreparedChanges } from "@/components/cockpit/prepared-changes";
import { ForbiddenState, LoadFailed, queryView } from "@/components/failure-state";
import { useI18n } from "@/lib/i18n-context";
import { LabelText } from "@/lib/machine-label";
import { cn } from "@/lib/utils";
import { NotificationSettings, useNotificationActions } from "@/pages/notification-settings";
import {
  isUnset,
  type SettingItem,
  type SettingNavGroup,
  type SettingsAttention,
  type SettingsFilter,
  type SettingsResponse,
  settingAppliesToShown,
  settingDiffersFromDefault,
  settingDraftError,
  settingFieldValue,
  settingHelpKey,
  settingIsChanged,
  settingLabel,
  settingLeafTarget,
  settingMetaLabel,
  settingNavigation,
  settingResetDraft,
  settingSecretCover,
  settingSecretName,
  settingSecretStored,
  settingSectionLabel,
  settingSectionOf,
  settingSourceIsNotable,
  settingsActivationPath,
  settingsAttention,
  settingsPatch,
  settingsSaveFailure,
  settingsViewFromUrl,
  settingUnit,
  settingValueText,
} from "@/pages/settings-model";
import {
  RESTART_STATUS_QUERY_KEY,
  SettingsRestartDialog,
  SettingsRestartOffer,
  useRestartOffer,
} from "@/pages/settings-restart";
import { restartOfferAfterSave, restartSaveNote } from "@/pages/settings-restart-model";

type ApiKeyProviderSetting = {
  protocol: "api_key";
  id: string;
  label: string;
};

type OidcProviderSetting = {
  protocol: "oidc";
  id: string;
  label: string;
  issuer_url: string;
  client_id: string;
  scopes: string;
  tenant_slug: string;
  link_by_email?: boolean;
  product_id?: string;
};

type OidcBearerProviderSetting = {
  protocol: "oidc_bearer";
  id: string;
  label: string;
  issuer_url: string;
  jwks_uri?: string;
  audience: string;
  algorithms?: string[];
  product_id: string;
  tenant_slug?: string;
  required_claims?: { path: string; equals: string | boolean | number }[];
  reject_anonymous?: boolean;
  clock_tolerance_s?: number;
};

type EditableAuthProvider = ApiKeyProviderSetting | OidcProviderSetting;

type ManagedAuthProvider = { readonly [field: string]: unknown };

export type AuthProviderSetting =
  | EditableAuthProvider
  | OidcBearerProviderSetting
  | ManagedAuthProvider;

function isEditableAuthProvider(provider: AuthProviderSetting): provider is EditableAuthProvider {
  return provider.protocol === "api_key" || provider.protocol === "oidc";
}

function providerText(provider: AuthProviderSetting, field: string): string {
  const value = provider[field as keyof AuthProviderSetting];
  return typeof value === "string" ? value : "";
}

export function authProvidersFrom(value: unknown): AuthProviderSetting[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (provider): provider is AuthProviderSetting =>
      typeof provider === "object" && provider !== null && !Array.isArray(provider),
  );
}

export function authProvidersFromDraft(
  raw: string | undefined,
  fallback: unknown,
): AuthProviderSetting[] {
  if (raw === undefined) return authProvidersFrom(fallback);
  try {
    return authProvidersFrom(JSON.parse(raw));
  } catch {
    return authProvidersFrom(fallback);
  }
}

export function replaceAuthProvider(
  value: readonly AuthProviderSetting[],
  index: number,
  provider: AuthProviderSetting,
): AuthProviderSetting[] {
  return value.map((current, currentIndex) => (currentIndex === index ? provider : current));
}

export function moveAuthProvider(
  value: readonly AuthProviderSetting[],
  index: number,
  direction: -1 | 1,
): AuthProviderSetting[] {
  const target = index + direction;
  if (target < 0 || target >= value.length) return [...value];
  const next = [...value];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export function removeAuthProvider(
  value: readonly AuthProviderSetting[],
  index: number,
): AuthProviderSetting[] {
  return value.filter((_, currentIndex) => currentIndex !== index);
}

function AuthProviderInput({
  label,
  testId,
  value,
  type = "text",
  disabled,
  onChange,
}: {
  label: string;
  testId: string;
  value: string;
  type?: "text" | "url";
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1 text-xs font-medium" htmlFor={testId}>
      {label}
      <Input
        id={testId}
        type={type}
        value={value}
        disabled={disabled}
        data-testid={testId}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function ManagedAuthProviderFacts({
  provider,
  index,
}: {
  provider: AuthProviderSetting;
  index: number;
}) {
  const { t } = useI18n();
  const facts: Fact[] = [
    { label: t("settings.auth.providerId"), value: providerText(provider, "id") || "—" },
  ];
  if (provider.protocol === "oidc_bearer") {
    facts.push(
      {
        label: t("settings.auth.issuerUrl"),
        value: providerText(provider, "issuer_url") || "—",
      },
      { label: t("settings.auth.audience"), value: providerText(provider, "audience") || "—" },
      { label: t("settings.auth.productId"), value: providerText(provider, "product_id") || "—" },
    );
  }
  return (
    <div className="grid gap-2">
      <FactList items={facts} testId={`settings-auth-provider-${index}-facts`} />
      <p className="text-xs text-muted-foreground">
        {provider.protocol === "oidc_bearer" ? (
          <a
            className="font-medium underline-offset-2 hover:underline"
            href={absolute(peopleHref("apps"))}
            data-testid={`settings-auth-provider-${index}-managed`}
          >
            {t("settings.auth.managedInApps")} →
          </a>
        ) : (
          <span data-testid={`settings-auth-provider-${index}-managed`}>
            {t("settings.auth.managedElsewhere")}
          </span>
        )}
      </p>
    </div>
  );
}

function authProviderKindLabel(
  provider: AuthProviderSetting,
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (provider.protocol === "oidc") return t("settings.auth.oidcPublicClient");
  if (provider.protocol === "api_key") return t("settings.auth.apiKey");
  if (provider.protocol === "oidc_bearer") return t("settings.auth.oidcBearer");
  return providerText(provider, "protocol") || t("settings.auth.unknownProtocol");
}

export function AuthProvidersEditor({
  value,
  publicBaseUrl,
  disabled,
  onChange,
}: {
  value: AuthProviderSetting[];
  publicBaseUrl: string;
  disabled: boolean;
  onChange: (value: AuthProviderSetting[]) => void;
}) {
  const { t } = useI18n();
  const [removing, setRemoving] = useState<number | null>(null);
  const removingProvider = removing === null ? null : value[removing];
  const callbackUrl = useMemo(() => {
    try {
      return new URL("/v1/identity/login/callback", publicBaseUrl).toString();
    } catch {
      return "/v1/identity/login/callback";
    }
  }, [publicBaseUrl]);

  function update(index: number, provider: AuthProviderSetting) {
    onChange(replaceAuthProvider(value, index, provider));
  }

  function move(index: number, direction: -1 | 1) {
    onChange(moveAuthProvider(value, index, direction));
  }

  return (
    <div className="grid gap-3" data-testid="settings-auth-providers">
      <div className="rounded-xl border border-border bg-muted/30 px-3 py-2">
        <p className="flex items-center gap-1 text-xs font-medium">
          {t("settings.auth.callbackUrl")}
          <ContextHelp
            label={`${t("pattern.help")}: ${t("settings.auth.callbackUrl")}`}
            testId="settings-auth-public-client"
          >
            {t("settings.auth.publicClientHint")}
          </ContextHelp>
        </p>
        <code className="mt-1 block break-all text-xs text-muted-foreground">{callbackUrl}</code>
      </div>
      {value.map((provider, index) => (
        <div
          key={`${providerText(provider, "protocol")}-${providerText(provider, "id")}-${index}`}
          className="grid gap-3 rounded-xl border border-border p-4"
          data-testid={`settings-auth-provider-${index}`}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {providerText(provider, "label") || t("settings.auth.unnamedProvider")}
              </p>
              <p className="text-xs text-muted-foreground">{authProviderKindLabel(provider, t)}</p>
            </div>
            <div className="flex items-center gap-1">
              <IconButton
                label={t("settings.auth.moveUp")}
                data-testid={`settings-auth-provider-${index}-move-up`}
                disabled={disabled || index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp />
              </IconButton>
              <IconButton
                label={t("settings.auth.moveDown")}
                data-testid={`settings-auth-provider-${index}-move-down`}
                disabled={disabled || index === value.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown />
              </IconButton>
              <IconButton
                label={t("settings.auth.remove")}
                data-testid={`settings-auth-provider-${index}-remove`}
                disabled={disabled || value.length === 1}
                onClick={() => setRemoving(index)}
              >
                <Trash2 />
              </IconButton>
            </div>
          </div>
          {isEditableAuthProvider(provider) ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <AuthProviderInput
                label={t("settings.auth.providerId")}
                testId={`settings-auth-provider-${index}-id`}
                value={provider.id}
                disabled={disabled}
                onChange={(id) => update(index, { ...provider, id })}
              />
              <AuthProviderInput
                label={t("settings.auth.label")}
                testId={`settings-auth-provider-${index}-label`}
                value={provider.label}
                disabled={disabled}
                onChange={(label) => update(index, { ...provider, label })}
              />
              {provider.protocol === "oidc" && (
                <>
                  <div className="sm:col-span-2">
                    <AuthProviderInput
                      label={t("settings.auth.issuerUrl")}
                      testId={`settings-auth-provider-${index}-issuer-url`}
                      type="url"
                      value={provider.issuer_url}
                      disabled={disabled}
                      onChange={(issuer_url) => update(index, { ...provider, issuer_url })}
                    />
                  </div>
                  <AuthProviderInput
                    label={t("settings.auth.clientId")}
                    testId={`settings-auth-provider-${index}-client-id`}
                    value={provider.client_id}
                    disabled={disabled}
                    onChange={(client_id) => update(index, { ...provider, client_id })}
                  />
                  <AuthProviderInput
                    label={t("settings.auth.scopes")}
                    testId={`settings-auth-provider-${index}-scopes`}
                    value={provider.scopes}
                    disabled={disabled}
                    onChange={(scopes) => update(index, { ...provider, scopes })}
                  />
                  <AuthProviderInput
                    label={t("settings.auth.tenantSlug")}
                    testId={`settings-auth-provider-${index}-tenant-slug`}
                    value={provider.tenant_slug}
                    disabled={disabled}
                    onChange={(tenant_slug) => update(index, { ...provider, tenant_slug })}
                  />
                </>
              )}
            </div>
          ) : (
            <ManagedAuthProviderFacts provider={provider} index={index} />
          )}
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        className="justify-self-start"
        disabled={disabled}
        data-testid="settings-auth-provider-add"
        onClick={() =>
          onChange([
            ...value,
            {
              protocol: "oidc",
              id: `oidc-${value.length + 1}`,
              label: "OIDC",
              issuer_url: "https://",
              client_id: "",
              scopes: "openid profile email",
              tenant_slug: "default",
            },
          ])
        }
      >
        <Plus data-icon="inline-start" /> {t("settings.auth.addOidc")}
      </Button>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        object={
          (removingProvider && providerText(removingProvider, "label")) ||
          t("settings.auth.unnamedProvider")
        }
        verb={t("settings.auth.remove")}
        consequence={t("settings.auth.removeConsequence")}
        destructive
        onConfirm={() => {
          if (removing !== null) onChange(removeAuthProvider(value, removing));
          setRemoving(null);
        }}
        testId="settings-auth-provider-remove-confirm"
      />
    </div>
  );
}

export function SettingsAttentionLine({
  attention,
  onOpenLeaf,
  restartOffer = null,
}: {
  attention: SettingsAttention | null;
  onOpenLeaf: (path: string) => void;
  restartOffer?: ReactNode;
}) {
  const { t } = useI18n();
  if (!attention) return null;
  return (
    <div
      role="status"
      className="grid gap-1 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm"
      data-testid="settings-attention"
    >
      {attention.restart.length > 0 ? (
        <p data-testid="settings-pending-restart">
          {t("settings.attention.restart")}{" "}
          {attention.restart.map((path, index) => (
            <span key={path}>
              {index > 0 ? ", " : null}
              <a
                className="font-medium underline-offset-2 hover:underline"
                href={absolute(settingsHref(path))}
                data-testid="settings-pending-restart-link"
                onClick={(event) => {
                  event.preventDefault();
                  onOpenLeaf(path);
                }}
              >
                <LabelText label={settingLabel(path, t)} />
                {index === attention.restart.length - 1 ? " →" : null}
              </a>
            </span>
          ))}
          {restartOffer}
        </p>
      ) : null}
      {attention.notActivated ? (
        <p>
          <a
            className="font-medium underline-offset-2 hover:underline"
            href={absolute(auditHref({ resourceType: "settings" }))}
            data-testid="settings-not-activated-link"
          >
            {t("settings.attention.notActivated")} →
          </a>
        </p>
      ) : null}
    </div>
  );
}

export function SettingsSectionNav({
  nav,
  current,
  hits,
  drafts,
  onOpen,
}: {
  nav: readonly SettingNavGroup[];
  current: string | null;
  hits: ReadonlySet<string> | null;
  drafts: ReadonlySet<string>;
  onOpen: (section: string) => void;
}) {
  const { t } = useI18n();
  return (
    <nav aria-label={t("settings.sections")} data-testid="settings-sections">
      {nav.map((group) => (
        <div key={group.id} className="mb-4 last:mb-0" data-testid={`settings-group-${group.id}`}>
          <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">{t(group.label)}</p>
          <ul className="grid gap-0.5">
            {group.sections.map((section) => {
              const dimmed = hits !== null && !hits.has(section);
              const active = section === current;
              return (
                <li key={section}>
                  <a
                    href={absolute(settingsHref(null, { section }))}
                    aria-current={active ? "page" : undefined}
                    data-dimmed={dimmed || undefined}
                    data-testid={`settings-section-link-${section}`}
                    className={cn(
                      "flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm break-words hover:bg-muted",
                      active && "bg-muted font-medium",
                      dimmed && "text-muted-foreground opacity-60",
                    )}
                    onClick={(event) => {
                      event.preventDefault();
                      onOpen(section);
                    }}
                  >
                    <span className="min-w-0 flex-1">
                      <LabelText label={settingSectionLabel(section, t)} />
                    </span>
                    {drafts.has(section) ? (
                      <span
                        className="size-1.5 shrink-0 rounded-full bg-foreground"
                        data-testid={`settings-section-draft-${section}`}
                      >
                        <span className="sr-only">{t("settings.sectionHasDrafts")}</span>
                      </span>
                    ) : null}
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export function SettingCopyKey({ item, index }: { item: SettingItem; index: number }) {
  const { t } = useI18n();
  const copy = useCopy();
  return (
    <IconButton
      label={t("settings.copyKey")}
      tooltip={
        <code className="font-mono">{t("settings.copyKeyTooltip", { key: item.path })}</code>
      }
      size="icon-xs"
      className="shrink-0 opacity-0 group-focus-within/setting:opacity-100 group-hover/setting:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
      data-testid={`setting-copy-key-${index}`}
      onClick={() => void copy(item.path)}
    >
      <Copy />
    </IconButton>
  );
}

export function SettingsSummary({
  total,
  changed,
  filter,
  onFilter,
}: {
  total: number;
  changed: number;
  filter: SettingsFilter;
  onFilter: (filter: SettingsFilter) => void;
}) {
  const { t } = useI18n();
  return (
    <SummaryLine
      testId="settings-summary"
      text={t("settings.summary", { count: String(total), changed: String(changed) })}
      help={t("settings.storage.body")}
      aside={<SettingsFilterToggle filter={filter} onChange={onFilter} />}
    />
  );
}

export function SettingDefaultLine({
  item,
  index,
  draft,
  disabled,
  onReset,
}: {
  item: SettingItem;
  index: number;
  draft: string | undefined;
  disabled: boolean;
  onReset?: (draft: string) => void;
}) {
  const { t } = useI18n();
  if (!settingDiffersFromDefault(item, draft)) return null;
  const reset = item.path === "auth.providers" ? null : settingResetDraft(item);
  return (
    <p
      className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground"
      data-testid={`setting-changed-${index}`}
    >
      <span className="font-medium text-foreground">{t("settings.changed")}</span>
      {typeof item.meta.default === "object" && item.meta.default !== null ? null : (
        <>
          <span aria-hidden="true">·</span>
          <span className="break-all" data-testid={`setting-default-${index}`}>
            {t("settings.defaultIs", { value: settingValueText(item.meta.default, t) })}
          </span>
        </>
      )}
      {reset !== null && onReset ? (
        <>
          <span aria-hidden="true">·</span>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            disabled={disabled}
            onClick={() => onReset(reset)}
            data-testid={`setting-reset-${index}`}
          >
            {t("settings.reset")}
          </Button>
        </>
      ) : null}
    </p>
  );
}

export function SettingSecretControl({
  item,
  index,
  draft,
  disabled,
  coveredBy,
  onDraft,
  onCancel,
}: {
  item: SettingItem;
  index: number;
  draft: string | undefined;
  disabled: boolean;
  coveredBy?: string | null;
  onDraft: (value: string) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const stored = settingSecretStored(item);
  if (draft === undefined)
    return (
      <p
        className="flex min-h-9 flex-wrap items-center gap-x-1.5 text-sm"
        data-testid={`setting-secret-${index}`}
        data-stored={stored || undefined}
      >
        <span
          className={cn(!stored && "text-muted-foreground")}
          data-testid={`setting-secret-state-${index}`}
        >
          {stored
            ? t("settings.secret.stored")
            : coveredBy
              ? t("settings.secret.covered", { setting: settingLabel(coveredBy, t).text })
              : t("settings.secret.notStored")}
        </span>
        <span aria-hidden="true" className="text-muted-foreground">
          ·
        </span>
        <Button
          id={`setting-${index}`}
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0"
          disabled={disabled}
          onClick={() => onDraft("")}
          data-testid={`setting-secret-edit-${index}`}
        >
          {t(stored ? "settings.secret.replace" : "settings.secret.store")}
        </Button>
      </p>
    );
  return (
    <div className="flex items-center gap-2">
      <Input
        id={`setting-${index}`}
        type="password"
        autoComplete="new-password"
        value={draft}
        placeholder={t("settings.secretPlaceholder")}
        onChange={(event) => onDraft(event.target.value)}
        disabled={disabled}
        data-testid={`setting-input-${index}`}
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled}
        onClick={onCancel}
        data-testid={`setting-secret-cancel-${index}`}
      >
        {t("common.cancel")}
      </Button>
    </div>
  );
}

const UNSET_OPTION = "__unset__";

export function SettingEnumSelect({
  item,
  index,
  value,
  disabled,
  onDraft,
}: {
  item: SettingItem;
  index: number;
  value: string;
  disabled: boolean;
  onDraft: (value: string) => void;
}) {
  const { t } = useI18n();
  const nullable = item.meta.default === null || item.value === null;
  return (
    <Select
      value={value === "" ? UNSET_OPTION : value}
      onValueChange={(next) => onDraft(next === UNSET_OPTION ? "" : next)}
      disabled={disabled}
    >
      <SelectTrigger
        id={`setting-${index}`}
        className="w-full"
        aria-label={settingLabel(item.path, t).text}
        data-testid={`setting-input-${index}`}
        data-kind="enum"
      >
        <SelectValue placeholder={t("settings.unset")} />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {nullable ? (
            <SelectItem value={UNSET_OPTION} data-testid={`setting-option-${index}-unset`}>
              {t("settings.unset")}
            </SelectItem>
          ) : null}
          {(item.meta.enum_values ?? []).map((option) => (
            <SelectItem
              key={option}
              value={option}
              data-testid={`setting-option-${index}-${option}`}
            >
              {option}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

export function SettingNumberInput({
  item,
  index,
  value,
  disabled,
  onDraft,
}: {
  item: SettingItem;
  index: number;
  value: string;
  disabled: boolean;
  onDraft: (value: string) => void;
}) {
  const { t } = useI18n();
  const unit = settingUnit(item.path);
  return (
    <div className="flex items-center gap-2">
      <Input
        id={`setting-${index}`}
        type="number"
        inputMode="decimal"
        value={value}
        placeholder={isUnset(item) ? t("settings.unset") : undefined}
        onChange={(event) => onDraft(event.target.value)}
        disabled={disabled}
        data-testid={`setting-input-${index}`}
      />
      {unit ? (
        <span
          className="shrink-0 text-sm text-muted-foreground"
          data-testid={`setting-unit-${index}`}
        >
          {t(unit)}
        </span>
      ) : null}
    </div>
  );
}

export function SettingsFilterToggle({
  filter,
  onChange,
}: {
  filter: SettingsFilter;
  onChange: (filter: SettingsFilter) => void;
}) {
  const { t } = useI18n();
  return (
    <SegmentedControl
      value={filter}
      onValueChange={(next) => {
        if (next === "all" || next === "changed") onChange(next);
      }}
      label={t("settings.filter.label")}
      testId="settings-filter"
      options={[
        { value: "all", label: t("settings.filter.all"), testId: "settings-filter-all" },
        {
          value: "changed",
          label: t("settings.filter.changed"),
          testId: "settings-filter-changed",
        },
      ]}
    />
  );
}

export function SettingsReadOnlyNotice({ canWrite }: { canWrite: boolean }) {
  const { t } = useI18n();
  if (canWrite) return null;
  return (
    <p
      role="status"
      className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm"
      data-testid="settings-read-only"
    >
      {t("settings.readOnly")}
    </p>
  );
}

export function SettingsSection({
  section,
  items,
  testId,
  children,
}: {
  section: string;
  items: readonly SettingItem[];
  testId: string;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <Section
      label={settingSectionLabel(section, t).text}
      testId={testId}
      aside={
        items.some((item) => item.meta.sensitive) ? (
          <ContextHelp
            label={`${t("pattern.help")}: ${settingSectionLabel(section, t).text}`}
            testId={`settings-secret-hint-${section}`}
          >
            {t("settings.secretExternalOnly")}
          </ContextHelp>
        ) : null
      }
    >
      <div className="overflow-hidden rounded-lg border">{children}</div>
    </Section>
  );
}

export function settingRowNotes(
  item: SettingItem,
  t: ReturnType<typeof useI18n>["t"],
): Array<{ id: "restart" | "source" | "applies-to"; text: string }> {
  return [
    ...(item.meta.requiresRestart ? [{ id: "restart" as const, text: t("settings.restart") }] : []),
    ...(settingSourceIsNotable(item.meta.source)
      ? [
          {
            id: "source" as const,
            text: t("settings.sourceIs", {
              source: settingMetaLabel(item.meta.source, t).text,
            }),
          },
        ]
      : []),
    ...(settingAppliesToShown(item.meta)
      ? [
          {
            id: "applies-to" as const,
            text: t("settings.appliesTo", { scope: settingMetaLabel(item.meta.scope, t).text }),
          },
        ]
      : []),
  ];
}

export function SettingRow({
  item,
  index,
  highlighted,
  draft,
  disabled = false,
  canCopyKey = false,
  onReset,
  children,
}: {
  item: SettingItem;
  index: number;
  highlighted: boolean;
  draft?: string;
  disabled?: boolean;
  canCopyKey?: boolean;
  onReset?: (draft: string) => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const wide = item.path === "auth.providers";
  const label = wide
    ? { text: t("settings.auth.providers"), machine: false }
    : settingLabel(item.path, t);
  const help = settingHelpKey(item.path);
  const invalid = settingDraftError(item, draft);
  const notes = settingRowNotes(item, t);
  return (
    <div
      data-action-scope="setting"
      className={cn(
        "group/setting grid scroll-mt-24 gap-2 border-t px-4 py-2.5 first:border-t-0",
        !wide &&
          "@min-[560px]/settings-panel:grid-cols-[minmax(0,1fr)_minmax(0,20rem)] @min-[560px]/settings-panel:items-center",
        highlighted && "bg-muted ring-1 ring-ring/40 ring-inset",
      )}
      data-highlighted={highlighted || undefined}
      data-setting-path={item.path}
      data-applies-to={settingAppliesToShown(item.meta) || undefined}
      data-requires-restart={item.meta.requiresRestart || undefined}
      data-testid={`setting-item-${index}`}
    >
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-0.5">
          {wide ? (
            <p className="min-w-0 text-sm font-medium break-words">{label.text}</p>
          ) : (
            <label className="min-w-0 text-sm font-medium break-words" htmlFor={`setting-${index}`}>
              <LabelText label={label} />
            </label>
          )}
          {help || notes.length > 0 ? (
            <ContextHelp
              label={`${t("pattern.help")}: ${label.text}`}
              testId={`setting-help-${index}`}
            >
              <span className="grid gap-1">
                {help ? <span>{t(help)}</span> : null}
                {notes.map((note) => (
                  <span key={note.id} data-testid={`setting-${note.id}-${index}`}>
                    {note.text}
                  </span>
                ))}
              </span>
            </ContextHelp>
          ) : null}
          {canCopyKey ? <SettingCopyKey item={item} index={index} /> : null}
        </div>
        <SettingDefaultLine
          item={item}
          index={index}
          draft={draft}
          disabled={disabled}
          onReset={onReset}
        />
      </div>
      <div className="min-w-0" data-slot="setting-control">
        {children}
        {invalid ? (
          <p
            role="alert"
            className="mt-1 text-xs text-destructive"
            data-testid={`setting-invalid-${index}`}
          >
            {t(invalid)}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function SettingsPage() {
  const { t } = useI18n();
  const session = useSession();
  const [createRule, setCreateRule] = useState(false);
  const [createChannel, setCreateChannel] = useState(false);
  const notificationActions = useNotificationActions({
    onCreateRule: () => setCreateRule(true),
    onCreateChannel: () => setCreateChannel(true),
  });
  const tabs = [
    ...(session.permissions.includes("settings:read")
      ? [
          {
            value: "system",
            label: t("settings.tab.system"),
            testId: "settings-tab-system",
            content: <SystemSettings />,
          },
        ]
      : []),
    ...(session.permissions.includes("notification:read")
      ? [
          {
            value: "notifications",
            label: t("nav.notifications"),
            testId: "settings-tab-notifications",
            content: (
              <NotificationSettings
                createRule={createRule}
                onCreateRule={setCreateRule}
                createChannel={createChannel}
                onCreateChannel={setCreateChannel}
              />
            ),
          },
        ]
      : []),
  ];
  const searchStr = useRouterState({ select: (state) => state.location.searchStr });
  const values = tabs.map((tab) => tab.value);
  const active = tabFromSearch(searchStr, "tab", values, values[0] ?? "");
  const onNotifications = active === "notifications";
  return (
    <Page
      kind="settings"
      scroll="page"
      testId="admin-settings"
      header={
        <PageHeader
          title={t("resource.settings.title")}
          action={onNotifications ? notificationActions.action : null}
          secondary={onNotifications ? notificationActions.secondary : null}
        />
      }
    >
      {tabs.length > 1 ? (
        <PageTabs tabs={tabs} param="tab" testId="settings-tabs" />
      ) : (
        (tabs[0]?.content ?? <ForbiddenState />)
      )}
    </Page>
  );
}

function SystemSettings() {
  const { t } = useI18n();
  const session = useSession();
  const client = useQueryClient();
  const canWrite = session.permissions.includes("settings:write:global");
  const canReadEngine = session.permissions.includes("settings:read:global");
  const [linked] = useState(() => settingsViewFromUrl(window.location.search));
  const [leaf, setLeaf] = useState(linked.leaf);
  const [filter, setFilter] = useState<SettingsFilter>(linked.leaf ? "all" : linked.filter);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [restartOpen, setRestartOpen] = useState(false);
  const restartNow = useRestartOffer();
  const saveOffer = restartOfferAfterSave(restartNow.offer, drafts["server.restart_supervised"]);
  const [restartNowOpen, setRestartNowOpen] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [activeSection, setActiveSection] = useState(
    linked.leaf ? settingSectionOf(linked.leaf) : (linked.section ?? ""),
  );
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [leafMissing, setLeafMissing] = useState(false);
  const focused = useRef(false);
  const live = useLiveQueryOptions();
  const query = useQuery({
    queryKey: ["admin", "settings"],
    queryFn: () => apiRequest<SettingsResponse>("/v1/settings"),
    ...live,
  });
  const allItems = query.data?.items ?? [];
  const publicBaseUrlItem = allItems.find((item) => item.path === "server.public_base_url");
  const publicBaseUrl =
    drafts["server.public_base_url"] ??
    (typeof publicBaseUrlItem?.value === "string"
      ? publicBaseUrlItem.value
      : (globalThis.location?.origin ?? ""));
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
  const pendingDrafts = useMemo(() => {
    const secret = new Set(allItems.filter((item) => item.meta.sensitive).map((item) => item.path));
    return Object.fromEntries(
      Object.entries(drafts).filter(([path, value]) => !(secret.has(path) && value === "")),
    );
  }, [allItems, drafts]);
  const draftSections = useMemo(
    () => new Set(Object.keys(pendingDrafts).map(settingSectionOf)),
    [pendingDrafts],
  );
  const changedItems = useMemo(
    () => allItems.filter((item) => Object.hasOwn(pendingDrafts, item.path)),
    [allItems, pendingDrafts],
  );
  const invalidDrafts = changedItems.some((item) => settingDraftError(item, drafts[item.path]));
  const selectedSection = orderedSections.includes(activeSection)
    ? activeSection
    : (orderedSections[0] ?? "");
  const attention = settingsAttention(query.data);
  const restartItems = changedItems.filter((item) => item.meta.requiresRestart);
  const changedCount = useMemo(() => allItems.filter(settingIsChanged).length, [allItems]);
  useDirtyGuard(changedItems.length > 0);
  useEffect(() => {
    const href = absolute(
      settingsHref(leaf, {
        section: leaf ? null : activeSection || null,
        filter: leaf || filter === "all" ? null : filter,
      }),
    );
    if (`${window.location.pathname}${window.location.search}` !== href)
      window.history.replaceState(window.history.state, "", href);
  }, [leaf, activeSection, filter]);
  useEffect(() => {
    if (focused.current || !leaf || !query.data) return;
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
  }, [leaf, query.data, allItems]);
  const save = useMutation({
    mutationFn: async () => {
      if (!query.data) throw new Error("settings are not loaded");
      const secretReferences: Record<string, string> = {};
      for (const item of changedItems.filter((candidate) => candidate.meta.sensitive)) {
        const created = await apiRequest<{ reference: string }>(
          `/v1/secrets/${encodeURIComponent(settingSecretName(item.path))}/versions`,
          { method: "POST", body: JSON.stringify({ value: pendingDrafts[item.path] }) },
        );
        secretReferences[item.path] = created.reference;
      }
      const patch = settingsPatch(query.data, pendingDrafts, secretReferences);
      const saved = await apiRequest<Parameters<typeof settingsActivationPath>[0]>("/v1/settings", {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      await apiRequest(settingsActivationPath(saved), { method: "POST" });
    },
    onSuccess: async () => {
      setDrafts({});
      setConflict(false);
      setRestartOpen(false);
      await client.invalidateQueries({ queryKey: ["admin", "settings"] });
      await client.invalidateQueries({ queryKey: RESTART_STATUS_QUERY_KEY });
      toast.success(t("settings.saved"));
    },
    onError: (error) => {
      setRestartOpen(false);
      if (settingsSaveFailure(error) === "conflict") setConflict(true);
      else toast.error(t("settings.saveFailed"));
    },
  });
  const settingsView = queryView(query, () => false);

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

  function reload() {
    void query.refetch().then((result) => {
      if (!result.isError) setConflict(false);
    });
  }

  function renderRow(item: SettingItem) {
    const index = allItems.indexOf(item);
    const disabled = !canWrite || save.isPending;
    const draft = (next: string) => setDrafts((current) => ({ ...current, [item.path]: next }));
    const dropDraft = () =>
      setDrafts((current) => {
        const { [item.path]: _dropped, ...rest } = current;
        return rest;
      });
    const rowProps = {
      item,
      index,
      highlighted: highlighted === item.path,
      draft: drafts[item.path],
      disabled,
      canCopyKey: canWrite,
      onReset: draft,
    };
    if (item.path === "auth.providers")
      return (
        <SettingRow key={item.path} {...rowProps}>
          <AuthProvidersEditor
            value={authProvidersFromDraft(drafts[item.path], item.value)}
            publicBaseUrl={publicBaseUrl}
            disabled={disabled}
            onChange={(next) => draft(JSON.stringify(next))}
          />
        </SettingRow>
      );
    if (item.path === "products")
      return (
        <SettingRow key={item.path} {...rowProps}>
          <div className="grid gap-2">
            <Input
              id={`setting-${index}`}
              type="text"
              value={settingFieldValue(item, drafts[item.path])}
              placeholder={isUnset(item) ? t("settings.unset") : undefined}
              onChange={(event) => draft(event.target.value)}
              disabled={disabled}
              data-testid={`setting-input-${index}`}
            />
            <a
              className="text-xs font-medium text-muted-foreground underline-offset-2 hover:underline"
              href={absolute(peopleHref("apps"))}
              data-testid={`setting-products-apps-${index}`}
            >
              {t("settings.products.appsView")} →
            </a>
          </div>
        </SettingRow>
      );
    if (item.meta.sensitive)
      return (
        <SettingRow key={item.path} {...rowProps}>
          <SettingSecretControl
            item={item}
            index={index}
            draft={drafts[item.path]}
            disabled={disabled}
            coveredBy={settingSecretCover(item, allItems)}
            onDraft={draft}
            onCancel={dropDraft}
          />
        </SettingRow>
      );
    const value = settingFieldValue(item, drafts[item.path]);
    return (
      <SettingRow key={item.path} {...rowProps}>
        {item.meta.kind === "boolean" || typeof item.value === "boolean" ? (
          <Switch
            id={`setting-${index}`}
            checked={value === "true"}
            onCheckedChange={(checked) => draft(String(checked))}
            disabled={disabled}
            aria-label={settingLabel(item.path, t).text}
            data-testid={`setting-input-${index}`}
          />
        ) : item.meta.kind === "enum" && item.meta.enum_values?.length ? (
          <SettingEnumSelect
            item={item}
            index={index}
            value={value}
            disabled={disabled}
            onDraft={draft}
          />
        ) : item.meta.kind === "number" ? (
          <SettingNumberInput
            item={item}
            index={index}
            value={value}
            disabled={disabled}
            onDraft={draft}
          />
        ) : (
          <Input
            id={`setting-${index}`}
            type="text"
            value={value}
            placeholder={isUnset(item) ? t("settings.unset") : undefined}
            onChange={(event) => draft(event.target.value)}
            disabled={disabled}
            data-testid={`setting-input-${index}`}
          />
        )}
      </SettingRow>
    );
  }

  const sectionItems = (section: string) =>
    allItems.filter((item) => settingSectionOf(item.path) === section);

  return (
    <div data-testid="settings-system" className="flex flex-col gap-4">
      {settingsView === "ready" ? (
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
      {canReadEngine ? <PreparedChanges canDecide={canWrite} /> : null}
      {settingsView === "loading" ? (
        <DataState state="loading" testId="settings-loading" />
      ) : settingsView === "error" ? (
        <LoadFailed
          title={t("resource.loadFailed", { resource: t("resource.settings.title") })}
          onRetry={() => void query.refetch()}
          testId="settings-load-failed"
        />
      ) : (
        <div className="@container/settings grid gap-5 pb-20" data-testid="settings-list">
          <SettingsReadOnlyNotice canWrite={canWrite} />
          <SettingsAttentionLine
            attention={attention}
            onOpenLeaf={openLeaf}
            restartOffer={
              <SettingsRestartOffer
                offer={restartNow.offer}
                onRestart={() => setRestartNowOpen(true)}
              />
            }
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
      )}
      {canWrite && (changedItems.length > 0 || conflict) && (
        <SettingsSaveBar
          count={changedItems.length}
          conflict={conflict}
          pending={save.isPending}
          invalid={invalidDrafts}
          onDiscard={() => {
            setDrafts({});
            setConflict(false);
          }}
          onReload={reload}
          onSave={() => (restartItems.length > 0 ? setRestartOpen(true) : save.mutate())}
        />
      )}
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
    </div>
  );
}

export function SettingsSaveBar({
  count,
  conflict,
  pending,
  invalid,
  onDiscard,
  onReload,
  onSave,
}: {
  count: number;
  conflict: boolean;
  pending: boolean;
  invalid: boolean;
  onDiscard: () => void;
  onReload: () => void;
  onSave: () => void;
}) {
  const { t } = useI18n();
  return (
    <SaveBar
      count={count}
      testId="settings-change-bar"
      notice={
        conflict ? (
          <span role="alert" data-testid="settings-conflict">
            {t("settings.conflict")}
          </span>
        ) : undefined
      }
      discard={{ onClick: onDiscard, testId: "settings-discard" }}
      save={
        conflict
          ? { onClick: onReload, label: t("settings.reload"), testId: "settings-conflict-reload" }
          : {
              onClick: onSave,
              pending,
              disabled: invalid || count === 0,
              testId: "settings-save",
            }
      }
    />
  );
}
