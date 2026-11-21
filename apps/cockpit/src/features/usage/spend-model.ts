import type { SpendLimit } from "@/api/spend-limit";
export type SpendTone = "success" | "warning" | "danger" | "neutral";
export type SpendIntent = "raise" | "continue" | null;

export interface SpendPanel {
  state: SpendLimit["state"];
  spent: number;
  limit: number | null;
  pct: number | null;
  tone: SpendTone;
  canRaise: boolean;
  canContinue: boolean;
  choices: number[];
}

const TONE: Record<SpendLimit["state"], SpendTone> = {
  unlimited: "neutral",
  ok: "success",
  warning: "warning",
  reached: "danger",
  continued: "warning",
};

export function spendPanel(spend: SpendLimit | undefined): SpendPanel | null {
  if (!spend?.countable) return null;
  return {
    state: spend.state,
    spent: spend.spent_usd,
    limit: spend.limit_usd,
    pct: spend.share === null ? null : Math.floor(spend.share * 100),
    tone: TONE[spend.state],
    canRaise: spendSettingMode(spend) === "edit",
    canContinue: spendSettingMode(spend) === "edit" && spend.state === "reached",
    choices: spend.choices.filter((choice) => choice === 0 || choice > spend.spent_usd),
  };
}

export type SpendSettingMode = "edit" | "read";

export function spendSettingMode(
  spend: Pick<SpendLimit, "can_change"> | undefined,
): SpendSettingMode {
  return spend?.can_change === true ? "edit" : "read";
}

export function spendIntent(search: string): SpendIntent {
  const value = new URLSearchParams(search).get("spend");
  return value === "raise" || value === "continue" ? value : null;
}

export function readOnlySpendPanel(panel: SpendPanel | null): SpendPanel | null {
  return panel ? { ...panel, canRaise: false, canContinue: false } : null;
}

export function usdFormatter(locale: string, currency = "USD"): (amount: number) => string {
  const format = new Intl.NumberFormat(locale === "de" ? "de-DE" : "en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  return (amount) => format.format(amount);
}
