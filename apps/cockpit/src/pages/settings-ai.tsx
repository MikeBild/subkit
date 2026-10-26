import { FlaskConical } from "lucide-react";
import { useState } from "react";
import { settingsHref } from "@/app/links";
import {
  Chip,
  CollapsibleSection,
  Input,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from "@/components/cockpit/patterns";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";
import { providerKeyPath } from "@/pages/settings-areas";
import { type ModelCatalogEntry, modelsFor, recommendedModel } from "@/pages/settings-catalog";
import {
  ExpertLink,
  type GuidedContext,
  GuidedRows,
  guidedDisabled,
  guidedIndex,
  guidedItem,
  guidedText,
  LockedNote,
  OwnValueHint,
  providerName,
  Question,
  ScopeToggle,
} from "@/pages/settings-guided";
import { settingSecretStored } from "@/pages/settings-model";
import { SettingSecretControl } from "@/pages/settings-rows";
import { moneyText } from "@/pages/settings-units";

export { providerName };

const PROVIDER_ORDER = [
  "openai",
  "anthropic",
  "gemini",
  "azure",
  "bedrock",
  "vertex",
  "ai_gateway",
  "mock",
] as const;

const PROVIDER_MARK: Readonly<Record<string, string>> = {
  openai: "AI",
  anthropic: "AN",
  gemini: "GE",
  azure: "AZ",
  bedrock: "BR",
  vertex: "VX",
  ai_gateway: "GW",
};

const PROVIDER_KEY_PAGES: Readonly<Record<string, string>> = {
  openai: "https://platform.openai.com/api-keys",
  anthropic: "https://console.anthropic.com/settings/keys",
  gemini: "https://aistudio.google.com/apikey",
};

const IT_PROVIDERS = new Set(["azure", "bedrock", "vertex", "ai_gateway"]);

const PROVIDER_FIELDS: Readonly<Record<string, readonly string[]>> = {
  azure: ["llm.providers.azure.resource_name"],
  bedrock: ["llm.providers.bedrock.region"],
  vertex: ["llm.providers.vertex.project", "llm.providers.vertex.location"],
};

const DEFAULT_MODEL = "__default__";
const CUSTOM_MODEL = "__custom__";
const PRIMARY_PROVIDER = "__primary__";

function providerLine(provider: string, t: (key: TranslationKey) => string): string {
  return t(`settings.ai.provider.${provider}.line` as TranslationKey);
}

function providerOptions(ctx: GuidedContext): string[] {
  const values = guidedItem(ctx, "llm.provider")?.meta.enum_values ?? [];
  return PROVIDER_ORDER.filter((provider) => values.includes(provider));
}

export function ModelBadges({ entry }: { entry: ModelCatalogEntry }) {
  const { t } = useI18n();
  return (
    <>
      {entry.badges.recommended ? <Chip>{t("settings.ai.badge.recommended")}</Chip> : null}
      {entry.badges.economical ? <Chip>{t("settings.ai.badge.economical")}</Chip> : null}
      {entry.badges.capable ? <Chip>{t("settings.ai.badge.capable")}</Chip> : null}
    </>
  );
}

export function providerSwitchChanges(
  ctx: GuidedContext,
  provider: string,
): Array<[string, string]> {
  if (provider === guidedText(ctx, "llm.provider")) return [];
  const family = modelsFor(ctx.catalog, provider);
  const following = ["llm.model", "llm.suggestion_model"];
  if (!guidedText(ctx, "llm.fallback_provider")) following.push("llm.fallback_model");
  if (!guidedText(ctx, "llm.summarize_provider")) following.push("llm.summarize_model");
  const cleared = following.filter((path) => {
    const model = guidedText(ctx, path);
    const known = ctx.catalog?.models.some((entry) => entry.model === model) ?? false;
    return model !== "" && known && !family?.some((entry) => entry.model === model);
  });
  return [["llm.provider", provider], ...cleared.map((path): [string, string] => [path, ""])];
}

function ProviderCards({ ctx }: { ctx: GuidedContext }) {
  const { t } = useI18n();
  const item = guidedItem(ctx, "llm.provider");
  const current = guidedText(ctx, "llm.provider");
  const disabled = guidedDisabled(ctx, item);
  const options = providerOptions(ctx);
  const choose = (provider: string) => applyDrafts(ctx, providerSwitchChanges(ctx, provider));
  return (
    <fieldset className="grid gap-3 sm:grid-cols-2" data-testid="settings-ai-providers">
      <legend className="sr-only">{t("settings.ai.provider.question")}</legend>
      {options.map((provider) => {
        const selected = provider === current;
        const mock = provider === "mock";
        return (
          <button
            key={provider}
            type="button"
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => choose(provider)}
            data-testid={`settings-ai-provider-${provider}`}
            data-selected={selected || undefined}
            className={cn(
              "grid grid-cols-[36px_minmax(0,1fr)] items-start gap-x-3 gap-y-0.5 rounded-xl border bg-background p-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60",
              (provider === "ai_gateway" || mock) && "sm:col-span-2",
              mock && "border-dashed",
              selected && "border-ring ring-1 ring-ring",
            )}
          >
            <span
              aria-hidden="true"
              className="row-span-2 inline-grid size-9 place-items-center rounded-md bg-muted text-[11px] font-semibold text-muted-foreground"
            >
              {mock ? <FlaskConical className="size-4" /> : PROVIDER_MARK[provider]}
            </span>
            <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
              {providerName(provider, t)}
              {selected ? (
                <Chip className="border-ring text-ring" testId="settings-ai-provider-selected">
                  {t("settings.ai.provider.selected")}
                </Chip>
              ) : null}
            </span>
            <span className="text-[13px] leading-[18px] text-muted-foreground">
              {providerLine(provider, t)}
            </span>
          </button>
        );
      })}
    </fieldset>
  );
}

function priceDetail(
  entry: ModelCatalogEntry,
  currency: string,
  locale: string,
  t: ReturnType<typeof useI18n>["t"],
) {
  if (entry.input_per_mtok === null || entry.output_per_mtok === null)
    return t("settings.ai.model.priceUnknown");
  return t("settings.ai.model.priceDetail", {
    inPrice: moneyText(entry.input_per_mtok, currency, locale),
    outPrice: moneyText(entry.output_per_mtok, currency, locale),
  });
}

function ModelPicker({
  ctx,
  path,
  provider,
  testId,
  named = true,
}: {
  ctx: GuidedContext;
  path: string;
  provider: string;
  testId: string;
  named?: boolean;
}) {
  const { t, locale } = useI18n();
  const item = guidedItem(ctx, path);
  const value = guidedText(ctx, path);
  const disabled = guidedDisabled(ctx, item);
  const models = modelsFor(ctx.catalog, provider);
  const currency = ctx.catalog?.currency ?? "USD";
  const listed = models?.some((entry) => entry.model === value) ?? false;
  const [custom, setCustom] = useState(false);
  const free = models === null || models.length === 0 || custom || (value !== "" && !listed);
  const name = providerName(provider, t);
  const recommended = named ? recommendedModel(ctx.catalog, provider) : null;
  const defaultLabel = recommended
    ? t("settings.ai.model.defaultNamed", { model: recommended.display_name })
    : t("settings.ai.model.default", { provider: name });
  if (!item) return null;
  if (free)
    return (
      <div className="grid gap-2">
        <Input
          id={`setting-${guidedIndex(ctx, path)}`}
          value={value}
          disabled={disabled}
          aria-label={t("settings.ai.model.label")}
          placeholder={t("settings.ai.model.customPlaceholder")}
          onChange={(event) => ctx.setDraft(path, event.target.value)}
          data-testid={`${testId}-custom`}
        />
        {models && models.length > 0 ? (
          <button
            type="button"
            className="justify-self-start text-xs font-medium underline-offset-2 hover:underline disabled:opacity-60"
            disabled={disabled}
            onClick={() => {
              setCustom(false);
              ctx.setDraft(path, "");
            }}
            data-testid={`${testId}-list`}
          >
            {defaultLabel}
          </button>
        ) : null}
      </div>
    );
  return (
    <Select
      value={value === "" ? DEFAULT_MODEL : value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next === CUSTOM_MODEL) {
          setCustom(true);
          return;
        }
        ctx.setDraft(path, next === DEFAULT_MODEL ? "" : next);
      }}
    >
      <SelectTrigger
        id={`setting-${guidedIndex(ctx, path)}`}
        className="w-full"
        aria-label={t("settings.ai.model.label")}
        data-testid={testId}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {(models ?? []).map((entry) => (
            <SelectItem
              key={entry.model}
              value={entry.model}
              title={priceDetail(entry, currency, locale, t)}
              suffix={
                <span className="inline-flex flex-wrap items-center gap-1">
                  <ModelBadges entry={entry} />
                  {entry.input_per_mtok === null ? null : (
                    <span className="text-xs">
                      {t("settings.ai.model.priceShort", {
                        amount: moneyText(entry.input_per_mtok, currency, locale),
                      })}
                    </span>
                  )}
                </span>
              }
              data-testid={`${testId}-option-${entry.model}`}
            >
              {entry.display_name}
            </SelectItem>
          ))}
          <SelectItem
            value={DEFAULT_MODEL}
            description={t("settings.ai.model.defaultHelp", { provider: name })}
            data-testid={`${testId}-option-default`}
          >
            {defaultLabel}
          </SelectItem>
          <SelectItem value={CUSTOM_MODEL} data-testid={`${testId}-option-custom`}>
            {t("settings.ai.model.custom")}
          </SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function ModelPriceLine({ ctx, provider }: { ctx: GuidedContext; provider: string }) {
  const { t, locale } = useI18n();
  const model = guidedText(ctx, "llm.model");
  const entry = modelsFor(ctx.catalog, provider)?.find((candidate) => candidate.model === model);
  const currency = ctx.catalog?.currency ?? "USD";
  return (
    <div className="grid gap-1 text-xs text-muted-foreground">
      {entry ? (
        <p data-testid="settings-ai-model-price">
          {t("settings.ai.model.priceSource")} · {priceDetail(entry, currency, locale, t)}
        </p>
      ) : model ? (
        <p data-testid="settings-ai-model-price">{t("settings.ai.model.priceUnknown")}</p>
      ) : null}
      <CollapsibleSection label={t("settings.ai.tokens.what")} testId="settings-ai-tokens">
        <p className="text-xs text-muted-foreground">{t("settings.ai.tokens.explain")}</p>
      </CollapsibleSection>
    </div>
  );
}

export function fallbackChange(previous: string, next: string): Array<[string, string]> {
  if (previous === next) return [];
  return [
    ["llm.fallback_provider", next],
    ["llm.fallback_model", ""],
  ];
}

export function summarizeChange(previous: string, next: string): Array<[string, string]> {
  if (previous === next) return [];
  return [
    ["llm.summarize_provider", next],
    ["llm.summarize_model", ""],
  ];
}

function applyDrafts(ctx: GuidedContext, changes: ReadonlyArray<[string, string]>) {
  for (const [path, text] of changes) ctx.setDraft(path, text);
}

function SummarizeQuestion({ ctx, provider }: { ctx: GuidedContext; provider: string }) {
  const { t } = useI18n();
  const item = guidedItem(ctx, "llm.summarize_provider");
  const chosen = guidedText(ctx, "llm.summarize_provider");
  const disabled = guidedDisabled(ctx, item);
  if (!item) return null;
  const target = chosen || provider;
  const options = (item.meta.enum_values ?? []).filter((value) => value !== "mock");
  return (
    <Question
      title={t("settings.ai.summarize.question")}
      help={t("settings.ai.summarize.help")}
      aside={<LockedNote item={item} />}
      testId="settings-ai-summarize"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <span className="text-xs font-medium">{t("settings.ai.summarize.provider")}</span>
          <Select
            value={chosen || PRIMARY_PROVIDER}
            disabled={disabled}
            onValueChange={(next) =>
              applyDrafts(ctx, summarizeChange(chosen, next === PRIMARY_PROVIDER ? "" : next))
            }
          >
            <SelectTrigger
              id={`setting-${guidedIndex(ctx, "llm.summarize_provider")}`}
              className="w-full"
              aria-label={t("settings.ai.summarize.provider")}
              data-testid="settings-ai-summarize-provider"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem
                  value={PRIMARY_PROVIDER}
                  data-testid="settings-ai-summarize-provider-primary"
                >
                  {t("settings.ai.summarize.primary", { provider: providerName(provider, t) })}
                </SelectItem>
                {options.map((option) => (
                  <SelectItem
                    key={option}
                    value={option}
                    data-testid={`settings-ai-summarize-provider-${option}`}
                  >
                    {providerName(option, t)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        {guidedItem(ctx, "llm.summarize_model") ? (
          <div className="grid gap-1.5">
            <span className="text-xs font-medium">{t("settings.ai.model.label")}</span>
            <ModelPicker
              key={target}
              ctx={ctx}
              path="llm.summarize_model"
              provider={target}
              testId="settings-ai-summarize-model"
            />
          </div>
        ) : null}
      </div>
      <OwnValueHint ctx={ctx} path="llm.summarize_provider" />
      <OwnValueHint ctx={ctx} path="llm.summarize_model" />
    </Question>
  );
}

function SuggestionQuestion({ ctx, provider }: { ctx: GuidedContext; provider: string }) {
  const { t } = useI18n();
  const item = guidedItem(ctx, "llm.suggestion_model");
  if (!item) return null;
  return (
    <Question
      title={t("settings.ai.suggestion.question")}
      help={t("settings.ai.suggestion.help", { provider: providerName(provider, t) })}
      aside={<LockedNote item={item} />}
      testId="settings-ai-suggestion"
    >
      <ModelPicker
        key={provider}
        ctx={ctx}
        path="llm.suggestion_model"
        provider={provider}
        testId="settings-ai-suggestion-model"
        named={false}
      />
      <OwnValueHint ctx={ctx} path="llm.suggestion_model" />
    </Question>
  );
}

function FallbackQuestion({ ctx, provider }: { ctx: GuidedContext; provider: string }) {
  const { t } = useI18n();
  const item = guidedItem(ctx, "llm.fallback_provider");
  const fallback = guidedText(ctx, "llm.fallback_provider");
  const disabled = guidedDisabled(ctx, item);
  if (!item) return null;
  const name = providerName(provider, t);
  const options = (item.meta.enum_values ?? []).filter((value) => value !== "mock");
  const same = fallback !== "" && fallback === provider;
  return (
    <Question
      title={t("settings.ai.fallback.question", { provider: name })}
      testId="settings-ai-fallback"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="grid gap-0.5">
          <label className="text-sm font-medium" htmlFor="settings-ai-fallback-toggle">
            {t("settings.ai.fallback.toggle")}
          </label>
          <p className="text-sm text-muted-foreground">
            {t(fallback ? "settings.ai.fallback.on" : "settings.ai.fallback.off", {
              provider: name,
            })}
          </p>
        </div>
        <Switch
          id="settings-ai-fallback-toggle"
          checked={fallback !== ""}
          disabled={disabled}
          onCheckedChange={(checked) =>
            applyDrafts(
              ctx,
              fallbackChange(
                fallback,
                checked ? (options.find((option) => option !== provider) ?? "") : "",
              ),
            )
          }
          data-testid="settings-ai-fallback-toggle"
        />
      </div>
      {fallback ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <span className="text-xs font-medium">{t("settings.ai.fallback.provider")}</span>
            <Select
              value={fallback}
              disabled={disabled}
              onValueChange={(next) => applyDrafts(ctx, fallbackChange(fallback, next))}
            >
              <SelectTrigger
                className="w-full"
                aria-label={t("settings.ai.fallback.provider")}
                aria-invalid={same || undefined}
                data-testid="settings-ai-fallback-provider"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {options.map((option) => (
                    <SelectItem
                      key={option}
                      value={option}
                      data-testid={`settings-ai-fallback-provider-${option}`}
                    >
                      {providerName(option, t)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <span className="text-xs font-medium">{t("settings.ai.model.label")}</span>
            <ModelPicker
              ctx={ctx}
              path="llm.fallback_model"
              provider={fallback}
              testId="settings-ai-fallback-model"
            />
          </div>
          {same ? (
            <p
              role="alert"
              className="text-xs text-destructive sm:col-span-2"
              data-testid="settings-ai-fallback-same"
            >
              {t("settings.ai.fallback.same", { provider: name })}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground sm:col-span-2">
            {t("settings.ai.fallback.hint")}
          </p>
        </div>
      ) : null}
      <OwnValueHint ctx={ctx} path="llm.fallback_provider" />
    </Question>
  );
}

function KeyRow({
  ctx,
  provider,
  primary,
}: {
  ctx: GuidedContext;
  provider: string;
  primary: boolean;
}) {
  const { t } = useI18n();
  const path = providerKeyPath(provider);
  const item = guidedItem(ctx, path);
  const name = providerName(provider, t);
  if (!item)
    return (
      <p
        className="text-sm text-muted-foreground"
        data-testid={`settings-ai-key-${provider}-elsewhere`}
      >
        {t("settings.ai.key.elsewhere")}
      </p>
    );
  const generalKey = primary ? guidedItem(ctx, "llm.api_key") : undefined;
  const covered = !settingSecretStored(item) && generalKey && settingSecretStored(generalKey);
  const draft = ctx.drafts[path];
  const page = PROVIDER_KEY_PAGES[provider];
  return (
    <div className="grid gap-1.5" data-testid={`settings-ai-key-${provider}`}>
      {primary ? null : <span className="text-xs font-medium">{name}</span>}
      <SettingSecretControl
        item={item}
        index={guidedIndex(ctx, path)}
        draft={draft}
        disabled={guidedDisabled(ctx, item)}
        coveredBy={covered ? "llm.api_key" : null}
        onDraft={(text) => ctx.setDraft(path, text)}
        onCancel={() => ctx.dropDraft(path)}
        labels={{
          store: t("settings.ai.key.store"),
          replace: t("settings.ai.key.replace"),
          covered: t("settings.ai.key.covered", { provider: name }),
          readOnly: t("settings.ai.key.readOnly"),
        }}
      />
      {draft !== undefined ? (
        <p className="text-xs text-muted-foreground">
          {t("settings.ai.key.security")}
          {settingSecretStored(item)
            ? ` ${t("settings.ai.key.replaceNote", { provider: name })}`
            : ""}
        </p>
      ) : null}
      {page ? (
        <a
          href={page}
          target="_blank"
          rel="noreferrer"
          className="justify-self-start text-xs font-medium underline-offset-2 hover:underline"
          data-testid={`settings-ai-key-${provider}-where`}
        >
          {t("settings.ai.key.where")}
        </a>
      ) : null}
    </div>
  );
}

export function AiArea({ ctx }: { ctx: GuidedContext }) {
  const { t } = useI18n();
  const provider = guidedText(ctx, "llm.provider");
  const providerItem = guidedItem(ctx, "llm.provider");
  const name = provider ? providerName(provider, t) : "";
  const fallback = guidedText(ctx, "llm.fallback_provider");
  const summarize = guidedText(ctx, "llm.summarize_provider");
  const extraKeys = [...new Set([fallback, summarize])].filter(
    (other) => other !== "" && other !== provider && other !== "mock",
  );
  const mock = provider === "mock";
  const extra = PROVIDER_FIELDS[provider] ?? [];
  return (
    <div className="grid gap-5" data-testid="settings-area-ai">
      <ScopeToggle ctx={ctx} />
      <Question
        title={t("settings.ai.provider.question")}
        help={t("settings.ai.provider.help")}
        aside={<LockedNote item={providerItem} />}
        testId="settings-ai-provider"
      >
        <ProviderCards ctx={ctx} />
        {mock ? (
          <p className="text-sm text-muted-foreground">{t("settings.ai.provider.mockHint")}</p>
        ) : IT_PROVIDERS.has(provider) ? (
          <p className="text-sm text-muted-foreground">{t("settings.ai.provider.itHint")}</p>
        ) : null}
        {extra.length > 0 ? <GuidedRows ctx={ctx} paths={extra} /> : null}
        <OwnValueHint ctx={ctx} path="llm.provider" />
        <p className="text-sm text-muted-foreground">{t("settings.ai.provider.later")}</p>
      </Question>
      {provider && !mock ? (
        <Question
          title={t("settings.ai.model.question", { provider: name })}
          help={t("settings.ai.model.help")}
          testId="settings-ai-model"
        >
          <ModelPicker
            ctx={ctx}
            path="llm.model"
            provider={provider}
            testId="settings-ai-model-select"
          />
          <ModelPriceLine ctx={ctx} provider={provider} />
          <OwnValueHint ctx={ctx} path="llm.model" />
        </Question>
      ) : null}
      {provider && !mock ? <FallbackQuestion ctx={ctx} provider={provider} /> : null}
      {provider && !mock ? <SummarizeQuestion ctx={ctx} provider={provider} /> : null}
      {provider && !mock ? <SuggestionQuestion ctx={ctx} provider={provider} /> : null}
      {provider ? (
        <Question
          title={t("settings.ai.key.question", { provider: name })}
          help={mock ? undefined : t("settings.ai.key.help", { provider: name })}
          testId="settings-ai-key"
        >
          {mock ? (
            <p className="text-sm text-muted-foreground">{t("settings.ai.key.mock")}</p>
          ) : (
            <div className="grid gap-4 divide-y [&>*:not(:first-child)]:pt-4">
              <KeyRow ctx={ctx} provider={provider} primary />
              {extraKeys.map((other) => (
                <KeyRow key={other} ctx={ctx} provider={other} primary={false} />
              ))}
            </div>
          )}
        </Question>
      ) : null}
      <div className="border-t pt-4">
        <ExpertLink
          href={settingsHref(null, { section: "llm" })}
          label={t("settings.level.areaExpert")}
          onNavigate={ctx.navigate}
          testId="settings-area-ai-expert"
        />
      </div>
    </div>
  );
}
