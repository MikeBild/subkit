import { localDateTime, zonedInstant } from "../../notifications/quiet-hours.ts";

export const SPEND_WARNING_SHARE = 0.8;
export const RUN_NOTICE_USD = 5;
export const SPEND_LIMIT_CHOICES = [20, 50, 200, 0] as const;
export const DEFAULT_SPEND_LIMIT_USD = 50;

export interface MonthWindow {
  month: string;
  from: Date;
  to: Date;
}

function monthKey(year: number, month: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

export function spendMonthWindow(now: Date, timezone: string): MonthWindow {
  const local = localDateTime(now, timezone);
  const nextYear = local.month === 12 ? local.year + 1 : local.year;
  const nextMonth = local.month === 12 ? 1 : local.month + 1;
  return {
    month: monthKey(local.year, local.month),
    from: zonedInstant({ year: local.year, month: local.month, day: 1 }, 0, timezone),
    to: zonedInstant({ year: nextYear, month: nextMonth, day: 1 }, 0, timezone),
  };
}

export function spendCurrency(configured: string | undefined, basis: string): string {
  return (configured ?? basis).trim().toUpperCase();
}

export function spendCountable(currency: string, basis: string): boolean {
  return currency === basis.trim().toUpperCase();
}

export function spendLimit(stored: number | undefined): number | null {
  const value = stored ?? DEFAULT_SPEND_LIMIT_USD;
  return Number.isFinite(value) && value > 0 ? value : null;
}

export type SpendState = "unlimited" | "ok" | "warning" | "reached" | "continued";

export interface SpendFacts {
  limit_usd: number | null;
  spent_usd: number;
  month: string;
  continue_month: string;
}

export interface SpendStatus {
  state: SpendState;
  limit_usd: number | null;
  spent_usd: number;
  share: number | null;
  month: string;
  continued: boolean;
  blocks_model_work: boolean;
}

export function spendStatus(facts: SpendFacts): SpendStatus {
  const continued = facts.continue_month !== "" && facts.continue_month === facts.month;
  const spent = Math.max(0, facts.spent_usd);
  if (facts.limit_usd === null)
    return {
      state: "unlimited",
      limit_usd: null,
      spent_usd: spent,
      share: null,
      month: facts.month,
      continued,
      blocks_model_work: false,
    };
  const share = spent / facts.limit_usd;
  const state: SpendState =
    share >= 1
      ? continued
        ? "continued"
        : "reached"
      : share >= SPEND_WARNING_SHARE
        ? "warning"
        : "ok";
  return {
    state,
    limit_usd: facts.limit_usd,
    spent_usd: spent,
    share,
    month: facts.month,
    continued,
    blocks_model_work: state === "reached",
  };
}

export type ModelWork =
  | { kind: "flow"; flow: string }
  | { kind: "workflow_step"; calls_model_provider: boolean }
  | { kind: "turn_helper"; helper: "suggest_next" | "tool_repair" };

export function isModelWork(work: ModelWork): boolean {
  if (work.kind === "workflow_step") return work.calls_model_provider;
  return true;
}

export function spendAllows(
  status: Pick<SpendStatus, "blocks_model_work">,
  work: ModelWork,
): boolean {
  return !(isModelWork(work) && status.blocks_model_work);
}

export type SpendAttention = { kind: "warning" | "reached"; id: string } | null;

export function spendAttention(status: SpendStatus): SpendAttention {
  if (status.state === "reached") return { kind: "reached", id: `spend-limit:${status.month}` };
  if (status.state === "warning") return { kind: "warning", id: `spend-warning:${status.month}` };
  return null;
}

export function spendChoiceDue(chosen: boolean): { id: string } | null {
  return chosen ? null : { id: "spend-limit-unset" };
}

export type SpendRun = "chat_turn" | "task_run";

export function runNoticeDue(p: {
  run: SpendRun;
  before_usd: number;
  after_usd: number;
  threshold_usd?: number;
}): { run_cost_usd: number; threshold_usd: number } | null {
  const threshold = p.threshold_usd ?? RUN_NOTICE_USD;
  const before = p.run === "chat_turn" ? 0 : Math.max(0, p.before_usd);
  const cost = p.run === "chat_turn" ? Math.max(0, p.after_usd - p.before_usd) : p.after_usd;
  if (before > threshold || cost <= threshold) return null;
  return { run_cost_usd: Math.round(cost * 100) / 100, threshold_usd: threshold };
}

export function roundUsd(amount: number): number {
  return Math.round(amount * 10_000) / 10_000;
}
