export function normalizeDecimal(text: string): string | null {
  const compact = text.trim().replace(/[\s'\u00a0\u202f]/g, "");
  if (!/^[\d.,]+$/.test(compact) || !/\d/.test(compact)) return null;
  const lastDot = compact.lastIndexOf(".");
  const lastComma = compact.lastIndexOf(",");
  let whole: string;
  let fraction = "";
  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = Math.max(lastDot, lastComma);
    whole = compact.slice(0, decimal);
    fraction = compact.slice(decimal + 1);
    const grouping = lastDot > lastComma ? "," : ".";
    if (!new RegExp(`^\\d{1,3}(\\${grouping}\\d{3})*$`).test(whole)) return null;
    whole = whole.split(grouping).join("");
  } else {
    const separator = lastDot >= 0 ? "." : lastComma >= 0 ? "," : null;
    if (separator === null) whole = compact;
    else {
      const parts = compact.split(separator);
      const grouped =
        parts.length > 2 ||
        (parts.length === 2 && parts[1]?.length === 3 && !/^0*$/.test(parts[0] ?? ""));
      if (grouped) {
        if (!parts.slice(1).every((part) => part.length === 3) || !parts[0]) return null;
        whole = parts.join("");
      } else {
        whole = parts[0] ?? "";
        fraction = parts[1] ?? "";
      }
    }
  }
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction)) return null;
  return fraction ? `${whole}.${fraction}` : whole;
}

export function parseAmount(text: string): number | null {
  const normalized = normalizeDecimal(text);
  if (normalized === null) return null;
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
  const normalized = normalizeDecimal(text);
  if (normalized === null) return null;
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
