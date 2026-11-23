import type { ScheduleEntry } from "../engine-client/workflows.ts";

type CostProjection = ScheduleEntry["cost_projection"];

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export function formatScheduleCost(projection: CostProjection): string {
  if (projection.state === "no_history") return "no estimate yet";
  if (projection.monthly_amount === null) return "unknown rhythm";
  const runs = `${projection.runs_sampled} run${projection.runs_sampled === 1 ? "" : "s"}`;
  const source = projection.basis === "workflow" ? `${runs}, earlier versions` : runs;
  const partial = projection.unpriced_models.length > 0 ? ", unpriced models left out" : "";
  return `≈ ${money(projection.monthly_amount, projection.currency)}/month (${source}${partial})`;
}
