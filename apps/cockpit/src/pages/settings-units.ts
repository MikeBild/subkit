export function parseAmount(text: string): number | null {
  const normalized = text.trim().replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

export function parseTokens(text: string): number | null {
  const digits = text.replace(/[\s.,'_]/g, "");
  if (!/^\d+$/.test(digits)) return null;
  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : null;
}

const MICROUNIT_DECIMALS = 6;
const MICROUNIT_MAX_DIGITS = 18;

export function dollarsToMicrounits(text: string): string | null {
  const normalized = text.trim().replace(/\s/g, "").replace(",", ".");
  const match = /^(\d+)(?:\.(\d+))?$/.exec(normalized);
  if (!match) return null;
  const whole = match[1] ?? "";
  const fraction = match[2] ?? "";
  if (fraction.length > MICROUNIT_DECIMALS) return null;
  const digits = `${whole}${fraction.padEnd(MICROUNIT_DECIMALS, "0")}`.replace(/^0+/, "");
  if (digits === "" || digits.length > MICROUNIT_MAX_DIGITS) return null;
  return digits;
}

export function microunitsToDollars(microunits: string): string | null {
  if (!/^(0|[1-9]\d*)$/.test(microunits) || microunits.length > MICROUNIT_MAX_DIGITS) return null;
  const padded = microunits.padStart(MICROUNIT_DECIMALS + 1, "0");
  const whole = padded.slice(0, -MICROUNIT_DECIMALS);
  const fraction = padded.slice(-MICROUNIT_DECIMALS).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

export type BudgetPresetId = "none" | "1m" | "10m" | "100m" | "custom";

export const BUDGET_PRESETS: readonly { id: Exclude<BudgetPresetId, "custom">; tokens: number }[] =
  [
    { id: "none", tokens: 0 },
    { id: "1m", tokens: 1_000_000 },
    { id: "10m", tokens: 10_000_000 },
    { id: "100m", tokens: 100_000_000 },
  ];

export function budgetPresetOf(tokens: number | null): BudgetPresetId {
  if (tokens === null) return "custom";
  return BUDGET_PRESETS.find((preset) => preset.tokens === tokens)?.id ?? "custom";
}

export function budgetPresetTokens(id: BudgetPresetId): number | null {
  return BUDGET_PRESETS.find((preset) => preset.id === id)?.tokens ?? null;
}

export function moneyText(amount: number, currency: string, locale: string): string {
  const tag = locale === "de" ? "de-DE" : "en-US";
  try {
    return new Intl.NumberFormat(tag, {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${new Intl.NumberFormat(tag, { minimumFractionDigits: 2 }).format(amount)} ${currency}`;
  }
}
