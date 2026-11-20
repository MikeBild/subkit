import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { apiCall } from "@/api/call";
import { ChoiceField, SelectField, TextField } from "@/components/cockpit/form-field";
import { FormDialog } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import {
  BUDGET_SETTING,
  llmStatsQuery,
  type StatsWindow,
  type WindowBounds,
} from "@/pages/operations-figures";
import { saveSetting } from "@/pages/settings-save";
import { parseAmount, parseTokens } from "@/pages/settings-units";
import { ORIGIN_LABEL, WINDOW_OPTION } from "@/pages/usage-format";
import {
  type BudgetForecast,
  type BudgetSummary,
  budgetPercent,
  budgetSummary,
  unpricedModels,
  usageCsv,
} from "@/pages/usage-model";

export const PRICE_SETTING = "tokens.prices";
const CURRENCY_SETTING = "tokens.currency";
const DEFAULT_CURRENCY = "USD";
const OFFERED_CURRENCIES = ["USD", "EUR"] as const;

type SettingScope = "tenant" | "global";

function readSetting(path: string, tenantId: string | null) {
  return apiCall("get", "/v1/settings/{path}", {
    path: { path },
    query: tenantId ? { tenant: tenantId } : {},
  });
}

function useSettingScope(tenantId: string) {
  const [scope, setScope] = useState<SettingScope>("tenant");
  return { scope, setScope, target: scope === "tenant" ? tenantId : null };
}

function ScopeField({
  scope,
  onScope,
  testId,
}: {
  scope: SettingScope;
  onScope(scope: SettingScope): void;
  testId: string;
}) {
  const { t } = useI18n();
  return (
    <ChoiceField
      label={t("settings.scope.question")}
      value={scope}
      onChange={onScope}
      options={[
        { value: "tenant", label: t("settings.scope.tenant") },
        { value: "global", label: t("settings.scope.global") },
      ]}
      description={t(
        scope === "tenant" ? "settings.scope.tenantHelp" : "settings.scope.globalHelp",
      )}
      testId={testId}
    />
  );
}

const SETTLE_ATTEMPTS = 10;
const SETTLE_DELAY_MS = 400;

async function settle<T>(read: () => Promise<T | null>): Promise<T | null> {
  for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt += 1) {
    const result = await read().catch(() => null);
    if (result !== null) return result;
    await new Promise((resolve) => setTimeout(resolve, SETTLE_DELAY_MS));
  }
  return null;
}

export function ForecastText({ forecast }: { forecast: BudgetForecast | null }) {
  const { t } = useI18n();
  if (!forecast) return null;
  if (forecast.kind === "runsOut") return <>{t("usage.forecast.runsOut", { day: forecast.day })}</>;
  if (forecast.kind === "tight")
    return <>{t("usage.forecast.tight", { percent: forecast.percent })}</>;
  if (forecast.kind === "exhausted") return <>{t("usage.forecast.exhausted")}</>;
  if (forecast.kind === "insufficient") return <>{t("usage.forecast.insufficient")}</>;
  if (forecast.kind === "lasts") return <>{t("usage.forecast.lasts")}</>;
  return null;
}

export function BudgetDialog({
  open,
  onOpenChange,
  budget,
  forecast,
  canWrite,
  canWriteGlobal,
  tenantId,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  tenantId: string;
  budget: BudgetSummary;
  forecast: BudgetForecast | null;
  canWrite: boolean;
  canWriteGlobal: boolean;
}) {
  const { t, locale } = useI18n();
  const client = useQueryClient();
  const tag = locale === "de" ? "de-DE" : "en-US";
  const tokens = new Intl.NumberFormat(tag);
  const [draft, setDraft] = useState(() =>
    budget.budgetTokens ? String(budget.budgetTokens) : "",
  );
  const value = parseTokens(draft);
  const { scope, setScope, target } = useSettingScope(tenantId);
  const save = useMutation({
    mutationFn: () => saveSetting(BUDGET_SETTING, target, value ?? 0),
    onSuccess: async () => {
      const expected = value && value > 0 ? value : null;
      const applied = await settle(async () => {
        const status = await apiCall("get", "/v1/status", {});
        return budgetSummary(status).budgetTokens === expected ? status : null;
      });
      if (applied) client.setQueryData(["usage-status"], applied);
      await client.invalidateQueries({ queryKey: ["usage-status"] });
      toast.success(t("usage.budget.saved"));
      onOpenChange(false);
    },
  });
  const percent = budgetPercent(budget);
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("usage.budget.title")}
      testId="usage-budget-dialog"
      submit={
        canWrite
          ? {
              label: t("common.save"),
              pending: save.isPending,
              disabled: value === null,
              testId: "usage-budget-save",
            }
          : undefined
      }
      onSubmit={canWrite ? () => save.mutate() : undefined}
      error={save.isError ? t("usage.budget.saveFailed") : null}
      failure={save.error}
    >
      <p className="text-sm" data-testid="usage-budget-state">
        {budget.budgetTokens !== null && budget.usedTokens !== null
          ? t("usage.budget.used", {
              used: tokens.format(budget.usedTokens),
              budget: tokens.format(budget.budgetTokens),
              percent: percent ?? 0,
            })
          : t("usage.budget.none")}{" "}
        <ForecastText forecast={forecast} />
      </p>
      {canWrite ? (
        <>
          <TextField
            id="usage-budget-tokens"
            label={t("usage.budget.field")}
            value={draft}
            onChange={setDraft}
            placeholder={t("usage.budget.placeholder")}
            help={t("usage.budget.help")}
            invalid={draft !== "" && value === null}
          />
          {canWriteGlobal ? (
            <ScopeField scope={scope} onScope={setScope} testId="usage-budget-scope" />
          ) : null}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{t("usage.askAdmin")}</p>
      )}
    </FormDialog>
  );
}

export function PriceDialog({
  open,
  onOpenChange,
  model,
  modelName,
  currentPrices,
  canWriteGlobal,
  tenantId,
  pricedBounds,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  tenantId: string;
  canWriteGlobal: boolean;
  pricedBounds: WindowBounds;
  model: string;
  modelName: string;
  currentPrices: readonly unknown[];
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const inputValue = parseAmount(input);
  const outputValue = parseAmount(output);
  const { scope, setScope, target } = useSettingScope(tenantId);
  const save = useMutation({
    mutationFn: async () => {
      const general = target === null ? (await readSetting(PRICE_SETTING, null)).value : null;
      const current = target === null ? (Array.isArray(general) ? general : []) : currentPrices;
      const others = current.filter(
        (entry) =>
          !(entry && typeof entry === "object" && (entry as { model?: unknown }).model === model),
      );
      return saveSetting(PRICE_SETTING, target, [
        ...others,
        { model, input_per_mtok: inputValue ?? 0, output_per_mtok: outputValue ?? 0 },
      ]);
    },
    onSuccess: async () => {
      await settle(async () => {
        const window = await apiCall("get", "/v1/stats/llm", {
          query: llmStatsQuery(pricedBounds),
        });
        return unpricedModels(window).includes(model) ? null : window;
      });
      await client.invalidateQueries({ queryKey: ["usage-llm"] });
      await client.invalidateQueries({ queryKey: ["usage-price-setting"] });
      toast.success(t("usage.price.saved"));
      onOpenChange(false);
    },
  });
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("usage.price.title", { name: modelName })}
      testId="usage-price-dialog"
      submit={{
        label: t("common.save"),
        pending: save.isPending,
        disabled: inputValue === null || outputValue === null,
        testId: "usage-price-save",
      }}
      onSubmit={() => save.mutate()}
      error={save.isError ? t("usage.price.saveFailed") : null}
      failure={save.error}
    >
      <TextField
        id="usage-price-input"
        label={t("usage.price.input")}
        value={input}
        onChange={setInput}
        placeholder={t("usage.price.inputPlaceholder")}
        invalid={input !== "" && inputValue === null}
      />
      <TextField
        id="usage-price-output"
        label={t("usage.price.output")}
        value={output}
        onChange={setOutput}
        placeholder={t("usage.price.outputPlaceholder")}
        invalid={output !== "" && outputValue === null}
      />
      {canWriteGlobal ? (
        <ScopeField scope={scope} onScope={setScope} testId="usage-price-scope" />
      ) : null}
    </FormDialog>
  );
}

export function CurrencyDialog({
  open,
  onOpenChange,
  canWriteGlobal,
  tenantId,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  canWriteGlobal: boolean;
  tenantId: string;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const { scope, setScope, target } = useSettingScope(tenantId);
  const stored = useQuery({
    queryKey: ["usage-currency-setting", target],
    queryFn: () => readSetting(CURRENCY_SETTING, target),
    retry: false,
  });
  const [draft, setDraft] = useState<string | null>(null);
  const current =
    typeof stored.data?.value === "string" ? stored.data.value.toUpperCase() : DEFAULT_CURRENCY;
  const currency = draft ?? current;
  const save = useMutation({
    mutationFn: () => saveSetting(CURRENCY_SETTING, target, currency),
    onSuccess: async () => {
      await settle(async () => {
        const applied = await readSetting(CURRENCY_SETTING, target);
        return applied.value === currency ? applied : null;
      });
      await client.invalidateQueries({ queryKey: ["usage-currency-setting"] });
      await client.invalidateQueries({ queryKey: ["usage-llm"] });
      toast.success(t("usage.currency.saved"));
      onOpenChange(false);
    },
  });
  const offered: readonly string[] = OFFERED_CURRENCIES;
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("usage.currency.title")}
      testId="usage-currency-dialog"
      submit={{
        label: t("common.save"),
        pending: save.isPending,
        disabled: stored.isPending || currency === current,
        testId: "usage-currency-save",
      }}
      onSubmit={() => save.mutate()}
      error={save.isError ? t("usage.currency.saveFailed") : null}
      failure={save.error}
    >
      <SelectField
        id="usage-currency"
        label={t("usage.currency.field")}
        value={currency}
        onChange={setDraft}
        options={[
          { value: "USD", label: t("usage.currency.usd") },
          { value: "EUR", label: t("usage.currency.eur") },
          ...(offered.includes(current)
            ? []
            : [{ value: current, label: t("usage.currency.other", { currency: current }) }]),
        ]}
        help={t("usage.currency.help")}
      />
      {canWriteGlobal ? (
        <ScopeField
          scope={scope}
          onScope={(next) => {
            setDraft(null);
            setScope(next);
          }}
          testId="usage-currency-scope"
        />
      ) : null}
    </FormDialog>
  );
}

export function ExportDialog({
  open,
  onOpenChange,
  bounds,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  bounds: WindowBounds;
}) {
  const { t } = useI18n();
  const unit = bounds.window === "24h" ? "hour" : "day";
  const run = useMutation({
    mutationFn: async () => {
      const envelope = await apiCall("get", "/v1/stats/llm", {
        query: llmStatsQuery(bounds, ["flow", "model"]),
      });
      const csv = usageCsv(envelope, unit, {
        period: t(unit === "hour" ? "usage.chart.hour" : "usage.chart.day"),
        origin: t("usage.csv.origin"),
        model: t("resource.usage.axis.model"),
        calls: t("usage.calls"),
        input: t("usage.tech.input"),
        output: t("usage.tech.output"),
        cacheRead: t("usage.tech.cacheRead"),
        cacheWritten: t("usage.tech.cacheWritten"),
        cost: t("resource.usage.cost"),
        currency: t("usage.csv.currency"),
        originName: (origin) => t(ORIGIN_LABEL[origin]),
      });
      const blob = new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" });
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = `usage-${bounds.from.slice(0, 10)}-${bounds.window}.csv`;
      link.click();
      URL.revokeObjectURL(href);
    },
    onSuccess: () => onOpenChange(false),
  });
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("usage.export.title")}
      testId="usage-export-dialog"
      submit={{
        label: t("usage.export.action"),
        pending: run.isPending,
        testId: "usage-export-run",
      }}
      onSubmit={() => run.mutate()}
      error={run.isError ? t("usage.export.failed") : null}
      failure={run.error}
    >
      <p className="text-sm">
        {t(unit === "hour" ? "usage.export.descriptionHour" : "usage.export.description", {
          period: t(WINDOW_OPTION[bounds.window as StatsWindow]),
        })}
      </p>
    </FormDialog>
  );
}
