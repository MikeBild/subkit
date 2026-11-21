import { useRouterState } from "@tanstack/react-router";
import { useMemo } from "react";
import { useI18n } from "@/lib/i18n-context";
import { spendIntent, spendPanel, usdFormatter } from "./spend-model";
import { SpendPanelView } from "./spend-panel";
import { useSpend } from "./use-spend";

export function SpendSettings() {
  const { locale } = useI18n();
  const spend = useSpend();
  const search = useRouterState({ select: (state) => state.location.searchStr });
  const usd = useMemo(
    () => usdFormatter(locale, spend.spend?.currency),
    [locale, spend.spend?.currency],
  );
  return (
    <SpendPanelView
      panel={spendPanel(spend.spend)}
      loading={spend.loading}
      failed={spend.failed}
      onRetry={spend.retry}
      usd={usd}
      intent={spendIntent(search)}
      saving={spend.saving}
      saveError={spend.saveError}
      onRaise={spend.raise}
      onContinue={spend.keepGoing}
    />
  );
}
