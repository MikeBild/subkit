import type { components } from "@cli-core/engine-api/openapi";
import { formatMoney, type Locale, type PluralKey, type Translate } from "@/lib/i18n";

export type ScheduleCostProjection = components["schemas"]["ScheduleCostProjection"];

type TranslatePlural = (key: PluralKey, count: number) => string;

export interface ScheduleCostWords {
  readonly amount: string;
  readonly basis: string;
  readonly estimated: boolean;
}

export function scheduleCostWords(
  projection: ScheduleCostProjection,
  t: Translate,
  tn: TranslatePlural,
  locale: Locale,
): ScheduleCostWords {
  if (projection.state === "no_history")
    return {
      amount: t("schedule.cost.none"),
      basis: t("schedule.cost.noneBasis"),
      estimated: false,
    };
  if (projection.monthly_amount === null)
    return { amount: t("schedule.cost.unknown"), basis: "", estimated: false };
  const basis = tn(
    projection.basis === "workflow"
      ? "schedule.cost.basis.workflow"
      : "schedule.cost.basis.version",
    projection.runs_sampled,
  );
  return {
    amount: t("schedule.cost.amount", {
      amount: formatMoney(locale, projection.monthly_amount, projection.currency),
    }),
    basis:
      projection.unpriced_models.length > 0 ? `${basis}. ${t("schedule.cost.unpriced")}` : basis,
    estimated: true,
  };
}
