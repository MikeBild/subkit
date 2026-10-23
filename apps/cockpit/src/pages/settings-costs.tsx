import { Check, Plus } from "lucide-react";
import { useState } from "react";
import { settingsHref } from "@/app/links";
import {
  Button,
  chipClass,
  FormDialog,
  Input,
  SegmentedControl,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";
import { providerName } from "@/pages/settings-ai";
import {
  ExpertLink,
  GlobalOnlyNote,
  type GuidedContext,
  guidedDisabled,
  guidedIndex,
  guidedItem,
  guidedText,
  LockedNote,
  OwnValueHint,
  Question,
  ScopeToggle,
} from "@/pages/settings-guided";
import {
  BUDGET_PRESETS,
  type BudgetPresetId,
  budgetPresetOf,
  dollarsToMicrounits,
  microunitsToDollars,
  moneyText,
  parseAmount,
} from "@/pages/settings-units";

interface PriceRow {
  model: string;
  name: string;
  input: number;
  output: number;
  own: boolean;
  currency: string;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function priceEntries(value: unknown): Array<Record<string, unknown> & { model: string }> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Record<string, unknown> & { model: string } =>
      Boolean(entry) && typeof entry === "object" && typeof entry.model === "string",
  );
}

export function hostedDraftText(text: string): string {
  return dollarsToMicrounits(text) ?? text;
}

export function hostedFieldText(
  saved: string,
  draft: string | undefined,
  editing: string | null,
): string {
  if (draft === undefined) return microunitsToDollars(saved) ?? saved;
  return editing ?? microunitsToDollars(draft) ?? draft;
}

export type HostedModelEntry = Record<string, unknown> & { model: string };

export function hostedModelChips(
  saved: readonly HostedModelEntry[],
  drafted: readonly HostedModelEntry[] | null,
  remembered: readonly HostedModelEntry[],
): { entries: HostedModelEntry[]; allowed: Set<string> } {
  const entries = new Map<string, HostedModelEntry>();
  for (const entry of [...remembered, ...saved, ...(drafted ?? [])])
    if (!entries.has(entry.model)) entries.set(entry.model, entry);
  return {
    entries: [...entries.values()],
    allowed: new Set((drafted ?? saved).map((entry) => entry.model)),
  };
}

export function hostedAllowlistDraft(
  entries: readonly HostedModelEntry[],
  allowed: ReadonlySet<string>,
): string {
  return JSON.stringify(entries.filter((entry) => allowed.has(entry.model)));
}

function BudgetQuestion({ ctx }: { ctx: GuidedContext }) {
  const { t, locale } = useI18n();
  const item = guidedItem(ctx, "tokens.monthly_budget");
  const text = guidedText(ctx, "tokens.monthly_budget");
  const parsed = /^\d+$/.test(text.trim()) ? Number(text.trim()) : null;
  const [customOpen, setCustomOpen] = useState(false);
  const preset: BudgetPresetId = customOpen ? "custom" : budgetPresetOf(parsed);
  const disabled = guidedDisabled(ctx, item);
  const tag = locale === "de" ? "de-DE" : "en-US";
  const number = new Intl.NumberFormat(tag);
  const provider = providerName(guidedText(ctx, "llm.provider") || "mock", t);
  if (!item) return null;
  const budget = parsed ?? 0;
  const used = ctx.usage?.usedTokens ?? null;
  const share = ctx.usage?.consumedShare ?? null;
  const invalid = preset === "custom" && (parsed === null || parsed < 1);
  const amount = t("settings.costs.tokens", { count: number.format(budget) });
  return (
    <Question
      title={t("settings.costs.budget.question")}
      help={t("settings.costs.budget.help")}
      aside={<LockedNote item={item} />}
      testId="settings-costs-budget"
    >
      <SegmentedControl
        value={preset}
        label={t("settings.costs.budget.question")}
        testId="settings-costs-budget-preset"
        onValueChange={(next) => {
          if (disabled) return;
          if (next === "custom") {
            setCustomOpen(true);
            return;
          }
          const found = BUDGET_PRESETS.find((candidate) => candidate.id === next);
          if (!found) return;
          setCustomOpen(false);
          ctx.setDraft("tokens.monthly_budget", String(found.tokens));
        }}
        options={[
          ...BUDGET_PRESETS.map((candidate) => ({
            value: candidate.id,
            label: t(`settings.costs.preset.${candidate.id}`),
            testId: `settings-costs-budget-${candidate.id}`,
          })),
          {
            value: "custom",
            label: t("settings.costs.preset.custom"),
            testId: "settings-costs-budget-custom",
          },
        ]}
      />
      {preset === "custom" ? (
        <div className="grid gap-1">
          <div className="flex items-center gap-2">
            <Input
              id={`setting-${guidedIndex(ctx, "tokens.monthly_budget")}`}
              inputMode="numeric"
              className="w-48"
              value={text}
              disabled={disabled}
              aria-invalid={invalid || undefined}
              aria-label={t("settings.costs.budget.custom")}
              onChange={(event) =>
                ctx.setDraft("tokens.monthly_budget", event.target.value.replace(/[\s.,'_]/g, ""))
              }
              data-testid="settings-costs-budget-input"
            />
            <span className="text-sm text-muted-foreground">
              {t("settings.costs.budget.custom")}
            </span>
          </div>
          {invalid ? (
            <p
              role="alert"
              className="text-xs text-destructive"
              data-testid="settings-costs-budget-invalid"
            >
              {t("settings.costs.budget.invalid")}
            </p>
          ) : null}
        </div>
      ) : null}
      {used !== null ? (
        <div className="grid gap-1" data-testid="settings-costs-usage">
          {budget > 0 && share !== null ? (
            <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
              <div className="h-full bg-primary" style={{ width: `${Math.round(share * 100)}%` }} />
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {budget > 0
              ? t("settings.costs.budget.usage", {
                  spent: t("settings.costs.tokens", { count: number.format(used) }),
                  amount,
                })
              : t("settings.costs.budget.usageNoLimit", {
                  spent: t("settings.costs.tokens", { count: number.format(used) }),
                })}
          </p>
        </div>
      ) : null}
      <p className="text-sm text-muted-foreground">
        {budget > 0
          ? t("settings.costs.budget.reached")
          : t("settings.costs.budget.noLimitHint", { provider })}
      </p>
      <p className="text-sm text-muted-foreground">
        {t("settings.costs.budget.estimate", { provider })}
      </p>
      <OwnValueHint ctx={ctx} path="tokens.monthly_budget" />
    </Question>
  );
}

function HostedAmount({ ctx, path, label }: { ctx: GuidedContext; path: string; label: string }) {
  const { t } = useI18n();
  const item = guidedItem(ctx, path);
  const [editing, setEditing] = useState<string | null>(null);
  if (!item) return null;
  const saved = typeof item.value === "string" ? item.value : "";
  const draft = ctx.drafts[path];
  const text = hostedFieldText(saved, draft, editing);
  const invalid = draft !== undefined && !/^[1-9]\d{0,17}$/.test(draft);
  return (
    <div className="grid gap-1">
      <label className="text-xs font-medium" htmlFor={`setting-${guidedIndex(ctx, path)}`}>
        {label}
      </label>
      <div className="flex items-center gap-2">
        <Input
          id={`setting-${guidedIndex(ctx, path)}`}
          inputMode="decimal"
          className="w-48"
          value={text}
          disabled={guidedDisabled(ctx, item)}
          aria-invalid={invalid || undefined}
          onChange={(event) => {
            setEditing(event.target.value);
            ctx.setDraft(path, hostedDraftText(event.target.value));
          }}
          data-testid={`settings-costs-${path}`}
        />
        <span className="text-sm text-muted-foreground">{t("settings.costs.hosted.unit")}</span>
      </div>
      {invalid ? (
        <p role="alert" className="text-xs text-destructive">
          {t("settings.costs.hosted.invalid")}
        </p>
      ) : null}
      <GlobalOnlyNote ctx={ctx} item={item} />
    </div>
  );
}

function PriceDialog({
  open,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onSave(row: { model: string; input: number; output: number }): void;
}) {
  const { t } = useI18n();
  const [model, setModel] = useState("");
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const inputValue = parseAmount(input);
  const outputValue = parseAmount(output);
  const valid = model.trim().length > 0 && inputValue !== null && outputValue !== null;
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("settings.costs.prices.dialog")}
      description={t("settings.costs.prices.dialogHelp")}
      testId="settings-costs-price-dialog"
      submit={{
        label: t("settings.costs.prices.add"),
        disabled: !valid,
        testId: "settings-costs-price-save",
      }}
      onSubmit={() => {
        if (!valid || inputValue === null || outputValue === null) return;
        onSave({ model: model.trim(), input: inputValue, output: outputValue });
        setModel("");
        setInput("");
        setOutput("");
        onOpenChange(false);
      }}
    >
      <div className="grid gap-3">
        <label className="grid gap-1 text-xs font-medium" htmlFor="settings-costs-price-model">
          {t("settings.costs.prices.model")}
          <Input
            id="settings-costs-price-model"
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder={t("settings.ai.model.customPlaceholder")}
            data-testid="settings-costs-price-model"
          />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-xs font-medium" htmlFor="settings-costs-price-input">
            {t("settings.costs.prices.read")}
            <Input
              id="settings-costs-price-input"
              inputMode="decimal"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              data-testid="settings-costs-price-input"
            />
          </label>
          <label className="grid gap-1 text-xs font-medium" htmlFor="settings-costs-price-output">
            {t("settings.costs.prices.write")}
            <Input
              id="settings-costs-price-output"
              inputMode="decimal"
              value={output}
              onChange={(event) => setOutput(event.target.value)}
              data-testid="settings-costs-price-output"
            />
          </label>
        </div>
        {!valid && (model || input || output) ? (
          <p className="text-xs text-muted-foreground">{t("settings.costs.prices.invalid")}</p>
        ) : null}
      </div>
    </FormDialog>
  );
}

function PricesQuestion({ ctx }: { ctx: GuidedContext }) {
  const { t, locale } = useI18n();
  const [adding, setAdding] = useState(false);
  const pricesItem = guidedItem(ctx, "tokens.prices");
  const currencyItem = guidedItem(ctx, "tokens.currency");
  const currency = (guidedText(ctx, "tokens.currency") || "USD").toUpperCase();
  const drafted =
    ctx.drafts["tokens.prices"] !== undefined
      ? priceEntries(parseJson(ctx.drafts["tokens.prices"]))
      : null;
  const builtInCurrency = ctx.catalog?.currency ?? "USD";
  const rows = new Map<string, PriceRow>();
  for (const entry of ctx.catalog?.models ?? [])
    rows.set(entry.model, {
      model: entry.model,
      name: entry.display_name,
      input: entry.input_per_mtok,
      output: entry.output_per_mtok,
      own: entry.price_source === "override",
      currency: builtInCurrency,
    });
  for (const entry of drafted ?? []) {
    const existing = rows.get(entry.model);
    rows.set(entry.model, {
      model: entry.model,
      name: existing?.name ?? entry.model,
      input: typeof entry.input_per_mtok === "number" ? entry.input_per_mtok : 0,
      output: typeof entry.output_per_mtok === "number" ? entry.output_per_mtok : 0,
      own: true,
      currency,
    });
  }
  const list = [...rows.values()];
  const disabled = guidedDisabled(ctx, pricesItem);
  const known = currency === "USD" || currency === "EUR";
  return (
    <Question
      title={t("settings.costs.prices.question")}
      help={t("settings.costs.prices.help")}
      testId="settings-costs-prices"
    >
      <p className="text-xs text-muted-foreground">{t("settings.costs.prices.unit")}</p>
      {currency !== builtInCurrency || currency !== "USD" ? (
        <p className="text-sm text-muted-foreground" data-testid="settings-costs-own-prices-needed">
          {t("settings.costs.currency.ownNeeded", { currency })}
        </p>
      ) : null}
      {list.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="settings-costs-prices-empty">
          {t("settings.costs.prices.empty")}
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm" data-testid="settings-costs-prices-table">
            <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">
                  {t("settings.costs.prices.model")}
                </th>
                <th className="px-3 py-2 text-left font-medium">
                  {t("settings.costs.prices.read")}
                </th>
                <th className="px-3 py-2 text-left font-medium">
                  {t("settings.costs.prices.write")}
                </th>
                <th className="px-3 py-2 text-left font-medium">
                  {t("settings.costs.prices.origin")}
                </th>
              </tr>
            </thead>
            <tbody className="[&>tr:not(:first-child)]:border-t">
              {list.map((row) => (
                <tr key={row.model} data-testid={`settings-costs-price-${row.model}`}>
                  <td className="px-3 py-2 font-medium">{row.name}</td>
                  <td className="px-3 py-2">{moneyText(row.input, row.currency, locale)}</td>
                  <td className="px-3 py-2">{moneyText(row.output, row.currency, locale)}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {row.own ? t("settings.costs.prices.own") : t("settings.costs.prices.builtin")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pricesItem ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="justify-self-start"
          disabled={disabled}
          onClick={() => setAdding(true)}
          data-testid="settings-costs-price-add"
        >
          <Plus data-icon="inline-start" /> {t("settings.costs.prices.add")}
        </Button>
      ) : null}
      <PriceDialog
        open={adding}
        onOpenChange={setAdding}
        onSave={(row) => {
          const current = drafted ?? priceEntries(pricesItem?.value);
          const next = [
            ...current.filter((entry) => entry.model !== row.model),
            { model: row.model, input_per_mtok: row.input, output_per_mtok: row.output },
          ];
          ctx.setDraft("tokens.prices", JSON.stringify(next));
        }}
      />
      {currencyItem ? (
        <div className="grid gap-1.5 border-t pt-4">
          <p className="text-sm font-medium">{t("settings.costs.currency.question")}</p>
          <Select
            value={currency}
            disabled={guidedDisabled(ctx, currencyItem)}
            onValueChange={(next) => ctx.setDraft("tokens.currency", next)}
          >
            <SelectTrigger
              className="w-full sm:w-72"
              aria-label={t("settings.costs.currency.question")}
              data-testid="settings-costs-currency"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="USD" data-testid="settings-costs-currency-usd">
                  {t("settings.costs.currency.usd")}
                </SelectItem>
                <SelectItem value="EUR" data-testid="settings-costs-currency-eur">
                  {t("settings.costs.currency.eur")}
                </SelectItem>
                {known ? null : (
                  <SelectItem value={currency} data-testid="settings-costs-currency-other">
                    {t("settings.costs.currency.other", { currency })}
                  </SelectItem>
                )}
              </SelectGroup>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t("settings.costs.currency.help")}</p>
        </div>
      ) : null}
    </Question>
  );
}

function AllowedModels({ ctx }: { ctx: GuidedContext }) {
  const { t } = useI18n();
  const item = guidedItem(ctx, "llm.hosted.models");
  if (!item) return null;
  const draftText = ctx.drafts["llm.hosted.models"];
  const { entries, allowed } = hostedModelChips(
    priceEntries(item.value),
    draftText !== undefined ? priceEntries(parseJson(draftText)) : null,
    priceEntries(ctx.rememberedHostedModels),
  );
  const disabled = guidedDisabled(ctx, item);
  const write = (models: ReadonlySet<string>) =>
    ctx.setDraft("llm.hosted.models", hostedAllowlistDraft(entries, models));
  const removed = entries.length - allowed.size;
  return (
    <Question
      title={t("settings.costs.allowed.question")}
      help={t("settings.costs.allowed.help")}
      testId="settings-costs-allowed"
    >
      <div className="flex flex-wrap gap-2">
        {entries.map((entry) => {
          const on = allowed.has(entry.model);
          return (
            <button
              key={entry.model}
              type="button"
              aria-pressed={on}
              disabled={disabled}
              className={cn(chipClass("md"), "rounded-full", on && "border-ring")}
              onClick={() => {
                const next = new Set(allowed);
                if (on) next.delete(entry.model);
                else next.add(entry.model);
                write(next);
              }}
              data-testid={`settings-costs-allowed-${entry.model}`}
            >
              {on ? <Check aria-hidden="true" /> : null}
              {entry.model}
            </button>
          );
        })}
      </div>
      <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
        <span data-testid="settings-costs-allowed-count">
          {allowed.size === 0
            ? t("settings.costs.allowed.empty")
            : t("settings.costs.allowed.count", { count: allowed.size, total: entries.length })}
        </span>
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs"
          disabled={disabled}
          onClick={() => write(new Set(entries.map((entry) => entry.model)))}
          data-testid="settings-costs-allowed-all"
        >
          {t("settings.costs.allowed.all")}
        </Button>
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs"
          disabled={disabled}
          onClick={() => write(new Set())}
          data-testid="settings-costs-allowed-none"
        >
          {t("settings.costs.allowed.none")}
        </Button>
      </p>
      {removed > 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="settings-costs-allowed-removed">
          {t("settings.costs.allowed.removed")}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">{t("settings.costs.allowed.more")}</p>
      <GlobalOnlyNote ctx={ctx} item={item} />
    </Question>
  );
}

export function CostsArea({ ctx }: { ctx: GuidedContext }) {
  const { t } = useI18n();
  const hosted = guidedItem(ctx, "llm.hosted.enabled")?.value === true;
  return (
    <div className="grid gap-5" data-testid="settings-area-costs">
      <ScopeToggle
        ctx={ctx}
        tenantLabel={t("settings.scope.costsTenant")}
        globalLabel={t("settings.scope.costsGlobal")}
        globalHelp={t("settings.scope.costsGlobalHelp")}
      />
      <BudgetQuestion ctx={ctx} />
      {hosted ? (
        <Question
          title={t("settings.costs.hosted.question")}
          help={t("settings.costs.hosted.help")}
          testId="settings-costs-hosted"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <HostedAmount
              ctx={ctx}
              path="llm.hosted.tenant_monthly_microunits"
              label={t("settings.costs.hosted.tenant")}
            />
            <HostedAmount
              ctx={ctx}
              path="llm.hosted.global_monthly_microunits"
              label={t("settings.costs.hosted.global")}
            />
          </div>
        </Question>
      ) : null}
      <PricesQuestion ctx={ctx} />
      {hosted ? <AllowedModels ctx={ctx} /> : null}
      <div className="border-t pt-4">
        <ExpertLink
          href={settingsHref(null, { section: "tokens" })}
          label={t("settings.level.areaExpert")}
          onNavigate={ctx.navigate}
          testId="settings-area-costs-expert"
        />
      </div>
    </div>
  );
}
