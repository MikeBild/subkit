import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { apiRequest } from "@/api/client";
import { TextField } from "@/components/cockpit/form-field";
import { FormDialog } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import {
  BUDGET_SETTING,
  llmStatsEndpoint,
  type StatsWindow,
  type WindowBounds,
} from "@/pages/operations-figures";
import { saveWorkspaceSetting } from "@/pages/settings-save";
import { ORIGIN_LABEL, WINDOW_OPTION } from "@/pages/usage-format";
import {
  type BudgetForecast,
  type BudgetSummary,
  budgetPercent,
  usageCsv,
} from "@/pages/usage-model";

export const PRICE_SETTING = "tokens.prices";

function parseAmount(text: string): number | null {
  const normalized = text.trim().replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function parseTokens(text: string): number | null {
  const digits = text.replace(/[\s.,'_]/g, "");
  if (!/^\d+$/.test(digits)) return null;
  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : null;
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
  tenantId,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  tenantId: string;
  budget: BudgetSummary;
  forecast: BudgetForecast | null;
  canWrite: boolean;
}) {
  const { t, locale } = useI18n();
  const client = useQueryClient();
  const tag = locale === "de" ? "de-DE" : "en-US";
  const tokens = new Intl.NumberFormat(tag);
  const [draft, setDraft] = useState(() =>
    budget.budgetTokens ? String(budget.budgetTokens) : "",
  );
  const value = parseTokens(draft);
  const save = useMutation({
    mutationFn: () => saveWorkspaceSetting(BUDGET_SETTING, tenantId, value ?? 0),
    onSuccess: async () => {
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
        <TextField
          id="usage-budget-tokens"
          label={t("usage.budget.field")}
          value={draft}
          onChange={setDraft}
          placeholder={t("usage.budget.placeholder")}
          help={t("usage.budget.help")}
          invalid={draft !== "" && value === null}
        />
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
  tenantId,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  tenantId: string;
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
  const save = useMutation({
    mutationFn: () => {
      const others = currentPrices.filter(
        (entry) =>
          !(entry && typeof entry === "object" && (entry as { model?: unknown }).model === model),
      );
      return saveWorkspaceSetting(PRICE_SETTING, tenantId, [
        ...others,
        { model, input_per_mtok: inputValue ?? 0, output_per_mtok: outputValue ?? 0 },
      ]);
    },
    onSuccess: async () => {
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
      const envelope = await apiRequest<unknown>(llmStatsEndpoint(bounds, ["flow", "model"]));
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
    >
      <p className="text-sm">
        {t(unit === "hour" ? "usage.export.descriptionHour" : "usage.export.description", {
          period: t(WINDOW_OPTION[bounds.window as StatsWindow]),
        })}
      </p>
    </FormDialog>
  );
}
