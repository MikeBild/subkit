import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  CheckCircle2,
  Copy,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { apiRequest } from "@/api/client";
import { absolute, auditHref, settingsHref } from "@/app/links";
import { useSession } from "@/app/session";
import { ConfirmAction } from "@/components/cockpit/confirm-action";
import { IconButton } from "@/components/cockpit/icon-button";
import { PageFrame } from "@/components/cockpit/page-frame";
import { PreparedChanges } from "@/components/cockpit/prepared-changes";
import { LoadFailed, queryView } from "@/components/failure-state";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useI18n } from "@/lib/i18n-context";
import { EngineWording, LabelText } from "@/lib/machine-label";
import { cn } from "@/lib/utils";
import {
  isUnset,
  type SettingItem,
  type SettingNavGroup,
  type SettingsAttention,
  type SettingsFilter,
  type SettingsResponse,
  settingDiffersFromDefault,
  settingDraftError,
  settingFieldValue,
  settingHelpKey,
  settingIsChanged,
  settingLabel,
  settingLeafTarget,
  settingMatches,
  settingMetaLabel,
  settingNavigation,
  settingResetDraft,
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
import { restartSaveNote } from "@/pages/settings-restart-model";

type AuthProviderSetting =
  | {
      protocol: "api_key";
      id: string;
      label: string;
    }
  | {
      protocol: "oidc";
      id: string;
      label: string;
      issuer_url: string;
      client_id: string;
      scopes: string;
      tenant_slug: string;
    };

function authProvidersFrom(value: unknown): AuthProviderSetting[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (provider): provider is AuthProviderSetting =>
      typeof provider === "object" &&
      provider !== null &&
      ((provider as { protocol?: unknown }).protocol === "api_key" ||
        (provider as { protocol?: unknown }).protocol === "oidc"),
  );
}

function authProvidersFromDraft(raw: string | undefined, fallback: unknown): AuthProviderSetting[] {
  if (raw === undefined) return authProvidersFrom(fallback);
  try {
    return authProvidersFrom(JSON.parse(raw));
  } catch {
    return authProvidersFrom(fallback);
  }
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

function AuthProvidersEditor({
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
  const callbackUrl = useMemo(() => {
    try {
      return new URL("/v1/identity/login/callback", publicBaseUrl).toString();
    } catch {
      return "/v1/identity/login/callback";
    }
  }, [publicBaseUrl]);

  function update(index: number, provider: AuthProviderSetting) {
    onChange(value.map((current, currentIndex) => (currentIndex === index ? provider : current)));
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= value.length) return;
    const next = [...value];
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  }

  return (
    <div className="grid gap-3" data-testid="settings-auth-providers">
      <div className="rounded-xl border border-border bg-muted/30 px-3 py-2">
        <p className="text-xs font-medium">{t("settings.auth.callbackUrl")}</p>
        <code className="mt-1 block break-all text-xs text-muted-foreground">{callbackUrl}</code>
        <p className="mt-2 text-xs text-muted-foreground">{t("settings.auth.publicClientHint")}</p>
      </div>
      {value.map((provider, index) => (
        <div
          key={`${provider.protocol}-${provider.id}-${index}`}
          className="grid gap-3 rounded-xl border border-border p-4"
          data-testid={`settings-auth-provider-${index}`}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {provider.label || t("settings.auth.unnamedProvider")}
              </p>
              <p className="text-xs text-muted-foreground">
                {provider.protocol === "oidc"
                  ? t("settings.auth.oidcPublicClient")
                  : t("settings.auth.apiKey")}
              </p>
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
              <ConfirmAction
                title={t("settings.auth.removeTitle", {
                  provider: provider.label || t("settings.auth.unnamedProvider"),
                })}
                consequence={
                  <>
                    <p>{t("settings.auth.removeConsequence")}</p>
                    <p>{t("settings.auth.removeLockout")}</p>
                  </>
                }
                confirmLabel={t("settings.auth.remove")}
                tone="destructive"
                onConfirm={() =>
                  onChange(value.filter((_, currentIndex) => currentIndex !== index))
                }
                testId={`settings-auth-provider-${index}-remove-confirm`}
                trigger={
                  <IconButton
                    label={t("settings.auth.remove")}
                    data-testid={`settings-auth-provider-${index}-remove`}
                    disabled={disabled || value.length === 1}
                  >
                    <Trash2 />
                  </IconButton>
                }
              />
            </div>
          </div>
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
    </div>
  );
}

/**
 * The one line above the sections, and only when there is something to do: a
 * saved setting waiting for a restart (each a link to its row), a last change
 * that did not activate (a link into the audit trail). The four tiles that
 * stood here — resolved count, saved and active revision, activation — were
 * read on every visit and asked nothing of anyone.
 */
export function SettingsAttentionLine({
  attention,
  onOpenLeaf,
  restartOffer = null,
}: {
  attention: SettingsAttention | null;
  onOpenLeaf: (path: string) => void;
  /** What stands after the waiting settings: the restart button, the manual
   * way, or the request to ask an admin. */
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

/**
 * Every section at once, grouped, stacked. It never scrolls sideways: names
 * wrap, and a long list scrolls down. Searching keeps every section in place
 * and dims those without a hit; a dot marks a section holding unsaved values.
 */
export function SettingsSectionNav({
  nav,
  current,
  hits,
  drafts,
  onOpen,
}: {
  nav: readonly SettingNavGroup[];
  current: string | null;
  /** Sections with a search hit, or null when nothing is searched. */
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

/**
 * What an operator needs only to look something up or report it: the key
 * (with a copy button), where the value comes from, what it applies to and
 * the engine's own English description. Collapsed; the row itself reads in
 * the reader's language.
 */
export function SettingTechnical({ item, index }: { item: SettingItem; index: number }) {
  const { t } = useI18n();
  return (
    <details className="mt-1 text-xs" data-testid={`setting-technical-${index}`}>
      <summary
        className="w-fit cursor-pointer text-muted-foreground hover:text-foreground"
        data-testid={`setting-technical-toggle-${index}`}
      >
        {t("settings.technical")}
      </summary>
      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">{t("settings.technical.key")}</dt>
        <dd className="flex min-w-0 items-center gap-1">
          <code className="min-w-0 break-all font-mono">{item.path}</code>
          <IconButton
            label={t("settings.technical.copyKey")}
            size="icon-xs"
            data-testid={`setting-copy-key-${index}`}
            onClick={() => {
              void navigator.clipboard
                ?.writeText(item.path)
                .then(() => toast.success(t("settings.technical.copied")));
            }}
          >
            <Copy />
          </IconButton>
        </dd>
        <dt className="text-muted-foreground">{t("settings.technical.source")}</dt>
        <dd>
          <LabelText label={settingMetaLabel(item.meta.source, t)} />
        </dd>
        <dt className="text-muted-foreground">{t("settings.technical.scope")}</dt>
        <dd>
          <LabelText label={settingMetaLabel(item.meta.scope, t)} />
        </dd>
      </dl>
      {item.meta.description ? (
        <EngineWording text={item.meta.description} testId={`setting-description-${index}`} />
      ) : null}
    </details>
  );
}

/**
 * "Geändert · Standard: X · Zurücksetzen" — only while the value on screen is
 * not the default. Zurücksetzen drafts the default like any other edit; the
 * save bar takes it from there. The provider list has no reset: its default
 * would drop every sign-in but the API key without the removal's confirm.
 */
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
      <span aria-hidden="true">·</span>
      <span className="break-all" data-testid={`setting-default-${index}`}>
        {t("settings.defaultIs", { value: settingValueText(item.meta.default, t) })}
      </span>
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

/**
 * A secret says whether one is stored, never what it is: "Hinterlegt ·
 * Ersetzen" or "Nicht hinterlegt · Hinterlegen". The field appears only after
 * the click, and "Abbrechen" takes it away with whatever was typed.
 */
export function SettingSecretControl({
  item,
  index,
  draft,
  disabled,
  onDraft,
  onCancel,
}: {
  item: SettingItem;
  index: number;
  draft: string | undefined;
  disabled: boolean;
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
        <span className={cn(!stored && "text-muted-foreground")}>
          {t(stored ? "settings.secret.stored" : "settings.secret.notStored")}
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

/** An enum is a choice among the engine's values, with "Nicht gesetzt" where null is allowed. */
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

/** A number is a numeric field, with its unit beside it where the setting's name says one. */
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

/** The one filter beside the search: every setting, or only those not at their default. */
export function SettingsFilterToggle({
  filter,
  onChange,
}: {
  filter: SettingsFilter;
  onChange: (filter: SettingsFilter) => void;
}) {
  const { t } = useI18n();
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      value={filter}
      onValueChange={(next) => {
        if (next === "all" || next === "changed") onChange(next);
      }}
      aria-label={t("settings.filter.label")}
      data-testid="settings-filter"
    >
      <ToggleGroupItem value="all" data-testid="settings-filter-all">
        {t("settings.filter.all")}
      </ToggleGroupItem>
      <ToggleGroupItem value="changed" data-testid="settings-filter-changed">
        {t("settings.filter.changed")}
      </ToggleGroupItem>
    </ToggleGroup>
  );
}

/** Shown once above the list to someone without settings:write; every control is disabled. */
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

/**
 * A section's heading, and — once, not on every secret row — the note on what
 * belongs in a secret field here.
 */
export function SettingsSectionHeading({
  section,
  items,
}: {
  section: string;
  items: readonly SettingItem[];
}) {
  const { t } = useI18n();
  return (
    <>
      <h2 className="text-base font-semibold">
        <LabelText label={settingSectionLabel(section, t)} />
      </h2>
      {items.some((item) => item.meta.sensitive) ? (
        <p
          className="mt-1 text-xs text-muted-foreground"
          data-testid={`settings-secret-hint-${section}`}
        >
          {t("settings.secretExternalOnly")}
        </p>
      ) : null}
    </>
  );
}

/**
 * One setting: its name, what to know before changing it, the control on the
 * right. The key, the source and the engine's wording are in the collapsed
 * technical details, not on the row.
 */
export function SettingRow({
  item,
  index,
  highlighted,
  draft,
  disabled = false,
  onReset,
  children,
}: {
  item: SettingItem;
  index: number;
  highlighted: boolean;
  draft?: string;
  disabled?: boolean;
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
  return (
    <div
      className={cn(
        "-mx-2 grid scroll-mt-24 gap-3 rounded-lg border-t px-2 py-4 first:border-t-0",
        !wide && "@min-[560px]/settings-panel:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]",
        highlighted && "bg-muted ring-1 ring-ring/40",
      )}
      data-highlighted={highlighted || undefined}
      data-testid={`setting-item-${index}`}
    >
      <div className="min-w-0">
        {wide ? (
          <p className="text-sm font-medium break-words">{label.text}</p>
        ) : (
          <label className="text-sm font-medium break-words" htmlFor={`setting-${index}`}>
            <LabelText label={label} />
          </label>
        )}
        {help ? (
          <p className="mt-0.5 text-xs text-muted-foreground" data-testid={`setting-help-${index}`}>
            {t(help)}
          </p>
        ) : null}
        <SettingDefaultLine
          item={item}
          index={index}
          draft={draft}
          disabled={disabled}
          onReset={onReset}
        />
        {item.meta.requiresRestart || settingSourceIsNotable(item.meta.source) ? (
          <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {item.meta.requiresRestart ? (
              <span data-testid={`setting-restart-${index}`}>{t("settings.restart")}</span>
            ) : null}
            {settingSourceIsNotable(item.meta.source) ? (
              <Badge variant="secondary" data-testid={`setting-source-${index}`}>
                <LabelText label={settingMetaLabel(item.meta.source, t)} />
              </Badge>
            ) : null}
          </p>
        ) : null}
        <SettingTechnical item={item} index={index} />
      </div>
      <div className="min-w-0">
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
  const client = useQueryClient();
  const canWrite = session.permissions.includes("settings:write");
  // The view lives in the address: a reload, a shared link and the J5 link
  // from the usage page all land on the same section, search, filter and field.
  const [linked] = useState(() => settingsViewFromUrl(window.location.search));
  const [leaf, setLeaf] = useState(linked.leaf);
  const [search, setSearch] = useState(linked.leaf ? "" : linked.q);
  const [filter, setFilter] = useState<SettingsFilter>(linked.leaf ? "all" : linked.filter);
  // Drafts belong to the page, not to a section: switching sections, searching
  // or filtering keeps them until they are saved or discarded. Nothing saves
  // on its own.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [restartOpen, setRestartOpen] = useState(false);
  const restartNow = useRestartOffer();
  const [restartNowOpen, setRestartNowOpen] = useState(false);
  // Somebody saved a newer revision since the page was read: the save bar says
  // so and asks for a reload; the drafts stay.
  const [conflict, setConflict] = useState(false);
  const [activeSection, setActiveSection] = useState(
    linked.leaf ? settingSectionOf(linked.leaf) : (linked.section ?? ""),
  );
  // On a narrow page the section list is the start view and a section opens
  // its own; a linked leaf or section opens it straight away.
  const [sectionOpen, setSectionOpen] = useState(Boolean(linked.leaf || linked.section));
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [leafMissing, setLeafMissing] = useState(false);
  const focused = useRef(false);
  const query = useQuery({
    queryKey: ["admin", "settings"],
    queryFn: () => apiRequest<SettingsResponse>("/v1/settings"),
  });
  const allItems = query.data?.items ?? [];
  const publicBaseUrlItem = allItems.find((item) => item.path === "server.public_base_url");
  const publicBaseUrl =
    drafts["server.public_base_url"] ??
    (typeof publicBaseUrlItem?.value === "string"
      ? publicBaseUrlItem.value
      : (globalThis.location?.origin ?? ""));
  const needle = search.trim();
  const listMode = needle !== "" || filter === "changed";
  const nav = useMemo(
    () => settingNavigation([...new Set(allItems.map((item) => settingSectionOf(item.path)))]),
    [allItems],
  );
  const orderedSections = useMemo(() => nav.flatMap((group) => group.sections), [nav]);
  const hits = useMemo(
    () =>
      listMode
        ? allItems.filter(
            (item) =>
              (!needle || settingMatches(item, needle, t)) &&
              (filter !== "changed" || settingIsChanged(item)),
          )
        : [],
    [allItems, listMode, needle, filter, t],
  );
  const hitSections = useMemo(
    () => (listMode ? new Set(hits.map((item) => settingSectionOf(item.path))) : null),
    [hits, listMode],
  );
  // An opened secret field with nothing typed is not a change yet.
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
  const showPanel = sectionOpen || listMode;
  const attention = settingsAttention(query.data);
  const restartItems = changedItems.filter((item) => item.meta.requiresRestart);
  useEffect(() => {
    const href = absolute(
      settingsHref(leaf, {
        section: leaf ? null : activeSection || null,
        q: leaf ? null : search.trim() || null,
        filter: leaf || filter === "all" ? null : filter,
      }),
    );
    if (`${window.location.pathname}${window.location.search}` !== href)
      window.history.replaceState(window.history.state, "", href);
  }, [leaf, activeSection, search, filter]);
  // Once the list is on screen: open the linked leaf's section, scroll to its
  // row, mark it and put the cursor in it. Once — a later refetch must not pull
  // focus back.
  useEffect(() => {
    if (focused.current || !leaf || !query.data) return;
    focused.current = true;
    // A group path (`llm.providers.anthropic`) opens its section at its first
    // setting; only a path nothing lives under is "no such setting".
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
      // The field itself where it has one; a composite editor (the auth
      // providers) has none, so its first control takes the cursor.
      const item = document.querySelector<HTMLElement>(`[data-testid="setting-item-${index}"]`);
      const field =
        document.getElementById(`setting-${index}`) ??
        item?.querySelector<HTMLElement>("input, button, select, textarea") ??
        null;
      // Vertically only; the page never scrolls sideways. The cursor goes in
      // without a second, unconstrained scroll of its own.
      (item ?? field)?.scrollIntoView({ block: "center", inline: "nearest" });
      field?.focus({ preventScroll: true });
    });
  }, [leaf, query.data, allItems]);
  // One save is one request: every draft of the page in a single PATCH
  // against the revision the page was read at. A secret is stored as a new
  // secret version first and travels as its reference. The saved revision is
  // then activated; one that needs a restart stays saved and says so.
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
    setSearch("");
    setFilter("all");
    setHighlighted(null);
    setLeafMissing(false);
    setActiveSection(section);
    setSectionOpen(true);
  }

  function openLeaf(path: string) {
    focused.current = false;
    setSearch("");
    setFilter("all");
    setLeafMissing(false);
    setActiveSection(settingSectionOf(path));
    setSectionOpen(true);
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
    if (item.meta.sensitive)
      return (
        <SettingRow key={item.path} {...rowProps}>
          <SettingSecretControl
            item={item}
            index={index}
            draft={drafts[item.path]}
            disabled={disabled}
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

  return (
    <PageFrame testId="admin-settings" title={t("resource.settings.title")} scroll="page">
      <PreparedChanges canDecide={canWrite} />
      <div
        className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end"
        data-family-slot="configuration-content"
      >
        <Input
          className="sm:max-w-sm"
          value={search}
          onChange={(event) => {
            setLeaf(null);
            setHighlighted(null);
            setSearch(event.target.value);
          }}
          placeholder={t("settings.search")}
          data-testid="settings-search"
        />
        <div className="flex items-center gap-2">
          <SettingsFilterToggle
            filter={filter}
            onChange={(next) => {
              setLeaf(null);
              setHighlighted(null);
              setFilter(next);
            }}
          />
          <IconButton
            variant="outline"
            label={t("common.refresh")}
            data-testid="settings-refresh"
            onClick={() => query.refetch()}
          >
            <RefreshCw />
          </IconButton>
        </div>
      </div>
      {settingsView === "loading" ? (
        <div className="grid gap-3" data-testid="settings-loading">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-20 w-full" />
          ))}
        </div>
      ) : settingsView === "error" ? (
        // Rendering the list anyway showed an installation with nothing
        // configured — a failed read presented as a fact about the configuration.
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
          {/* One column no wider than the page (`minmax(0, …)`): nothing in
              here may make the page scroll sideways. From 720px of content the
              list stands left of the section; below, the list is the start
              view and a section opens in its place. */}
          <div className="grid grid-cols-[minmax(0,1fr)] gap-6 @min-[720px]/settings:grid-cols-[200px_minmax(0,1fr)]">
            <div
              className={cn(
                "min-w-0 self-start overflow-x-hidden @min-[720px]/settings:sticky @min-[720px]/settings:top-0 @min-[720px]/settings:max-h-[calc(100dvh-7rem)] @min-[720px]/settings:overflow-y-auto",
                showPanel && "hidden @min-[720px]/settings:block",
              )}
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
            <div
              className={cn(
                "@container/settings-panel min-w-0",
                !showPanel && "hidden @min-[720px]/settings:block",
              )}
              data-testid="settings-panel"
            >
              <Button
                variant="ghost"
                size="sm"
                className="mb-3 -ml-2 @min-[720px]/settings:hidden"
                data-testid="settings-back"
                onClick={() => {
                  setSectionOpen(false);
                  setSearch("");
                  setFilter("all");
                  setLeaf(null);
                  setHighlighted(null);
                }}
              >
                <ArrowLeft data-icon="inline-start" />
                {t("settings.allSections")}
              </Button>
              {listMode ? (
                hits.length === 0 ? (
                  <Empty
                    className="min-h-52 border"
                    data-testid={needle ? "settings-no-matches" : "settings-all-default"}
                  >
                    <EmptyHeader>
                      <EmptyTitle>
                        {needle ? t("settings.noMatches") : t("settings.allDefault")}
                      </EmptyTitle>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  <div className="grid gap-6" data-testid="settings-hits">
                    {orderedSections
                      .filter((section) => hitSections?.has(section))
                      .map((section) => {
                        const sectionHits = hits.filter(
                          (item) => settingSectionOf(item.path) === section,
                        );
                        return (
                          <section key={section} data-testid={`settings-hits-${section}`}>
                            <SettingsSectionHeading section={section} items={sectionHits} />
                            <div className="mt-2">{sectionHits.map(renderRow)}</div>
                          </section>
                        );
                      })}
                  </div>
                )
              ) : (
                <section data-testid={`settings-section-${selectedSection}`}>
                  <SettingsSectionHeading
                    section={selectedSection}
                    items={allItems.filter(
                      (item) => settingSectionOf(item.path) === selectedSection,
                    )}
                  />
                  <div className="mt-2">
                    {allItems
                      .filter((item) => settingSectionOf(item.path) === selectedSection)
                      .map(renderRow)}
                  </div>
                </section>
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
      <AlertDialog open={restartOpen} onOpenChange={(open) => !open && setRestartOpen(false)}>
        <AlertDialogContent data-testid="settings-restart-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.restartTitle")}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="grid gap-2" data-testid="settings-restart-description">
                <p>{t("settings.restartDescription")}</p>
                <ul className="grid gap-0.5 pl-4">
                  {restartItems.map((item) => (
                    <li key={item.path} className="list-disc">
                      {settingLabel(item.path, t).text}{" "}
                      <span className="font-mono text-xs">{item.path}</span>
                    </li>
                  ))}
                </ul>
                <p>{t(restartSaveNote(restartNow.offer))}</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="settings-restart-cancel">
              {t("common.cancel")}
            </AlertDialogCancel>
            {restartNow.offer === "restart" ? (
              <AlertDialogAction
                variant="outline"
                onClick={() => save.mutate(undefined, { onSuccess: () => setRestartNowOpen(true) })}
                data-testid="settings-restart-save-then-restart"
              >
                {t("settings.saveThenRestart")}
              </AlertDialogAction>
            ) : null}
            <AlertDialogAction onClick={() => save.mutate()} data-testid="settings-restart-confirm">
              {t("settings.saveAndRestart")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {restartNow.offer === "restart" ? (
        <SettingsRestartDialog
          open={restartNowOpen}
          onOpenChange={setRestartNowOpen}
          pendingFields={attention?.restart ?? restartNow.status?.pending_restart_fields ?? []}
        />
      ) : null}
    </PageFrame>
  );
}

/**
 * The one save bar of the page, for every section's drafts at once: "N
 * ungespeicherte Änderungen · Verwerfen · Speichern". After a conflict it says
 * somebody saved in the meantime and offers the reload; the drafts stay.
 */
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
    <div
      className="sticky bottom-3 z-10 -mx-1 mt-4 flex flex-col gap-3 rounded-xl bg-background/95 p-3 shadow-lg ring-1 ring-foreground/10 backdrop-blur sm:flex-row sm:items-center sm:justify-between"
      role="status"
      data-testid="settings-change-bar"
    >
      <div className="flex items-start gap-2">
        <CheckCircle2 className="mt-0.5 size-4 text-foreground/70" aria-hidden="true" />
        <div>
          <p className="text-sm font-medium">{t("settings.unsavedCount", { count })}</p>
          {conflict ? (
            <p role="alert" className="text-xs text-destructive" data-testid="settings-conflict">
              {t("settings.conflict")}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">{t("settings.unsavedHint")}</p>
          )}
        </div>
      </div>
      <div className="flex gap-2">
        <Button
          className="flex-1 sm:flex-none"
          variant="outline"
          disabled={pending}
          onClick={onDiscard}
          data-testid="settings-discard"
        >
          {t("common.discard")}
        </Button>
        {conflict ? (
          <Button
            className="flex-1 sm:flex-none"
            onClick={onReload}
            data-testid="settings-conflict-reload"
          >
            {t("settings.reload")}
          </Button>
        ) : (
          <Button
            className="flex-1 sm:flex-none"
            disabled={pending || invalid || count === 0}
            onClick={onSave}
            data-testid="settings-save"
          >
            {pending && <Spinner data-icon="inline-start" />}
            {t("common.save")}
          </Button>
        )}
      </div>
    </div>
  );
}
