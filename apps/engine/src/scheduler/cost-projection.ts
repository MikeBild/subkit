import { calendarGateSkipReason, readCalendarGates } from "./calendar-gates.ts";
import { cronOccurrencesWithin, parseCronExpression } from "./cron.ts";

const DAY_MS = 86_400_000;
const YEAR_MS = 365 * DAY_MS;
const MONTHS_PER_YEAR = 12;
const MONTH_MS = YEAR_MS / MONTHS_PER_YEAR;
export const OCCURRENCE_CAP = 10_000;

export const COST_PROJECTION_STATES = ["estimated", "no_history", "unknown_rhythm"] as const;
export const COST_PROJECTION_BASES = ["version", "workflow"] as const;

export type CostProjectionState = (typeof COST_PROJECTION_STATES)[number];
export type CostProjectionBasis = (typeof COST_PROJECTION_BASES)[number];

export interface RunCostSample {
  readonly runs: number;
  readonly amount: number;
  readonly unpriced_models: readonly string[];
}

export interface ScheduleCostProjection {
  readonly state: CostProjectionState;
  readonly basis: CostProjectionBasis | null;
  readonly runs_sampled: number;
  readonly runs_per_month: number | null;
  readonly per_run_amount: number | null;
  readonly monthly_amount: number | null;
  readonly currency: string;
  readonly unpriced_models: string[];
  readonly rates_basis: "current";
}

interface RhythmInput {
  readonly cron: string;
  readonly timezone: string;
  readonly input?: unknown;
}

const round = (value: number, digits: number) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

export function runsPerMonth(rhythm: RhythmInput, at: Date): number | null {
  const parsed = parseCronExpression(rhythm.cron);
  if (!parsed.ok) return null;
  if (parsed.mode === "every") return round(MONTH_MS / ((parsed.everySeconds ?? 0) * 1000), 2);
  const tz = rhythm.timezone || "UTC";
  const end = new Date(at.getTime() + YEAR_MS);
  const occurrences = cronOccurrencesWithin(rhythm.cron, at, end, tz, OCCURRENCE_CAP);
  const last = occurrences[occurrences.length - 1];
  if (!last) return 0;
  const gates = readCalendarGates(rhythm.input);
  const open = occurrences.filter((when) => calendarGateSkipReason(when, tz, gates) === null);
  const span = occurrences.length >= OCCURRENCE_CAP ? last.getTime() - at.getTime() : YEAR_MS;
  if (span <= 0) return null;
  return round((open.length * MONTH_MS) / span, 2);
}

export function projectScheduleCost(p: {
  readonly runs_per_month: number | null;
  readonly version: RunCostSample | null;
  readonly workflow: RunCostSample | null;
  readonly currency: string;
}): ScheduleCostProjection {
  const base = {
    runs_per_month: p.runs_per_month,
    currency: p.currency,
    rates_basis: "current" as const,
  };
  const sample = p.version && p.version.runs > 0 ? p.version : p.workflow;
  const basis: CostProjectionBasis | null =
    p.version && p.version.runs > 0
      ? "version"
      : p.workflow && p.workflow.runs > 0
        ? "workflow"
        : null;
  if (!sample || basis === null)
    return {
      ...base,
      state: p.runs_per_month === null ? "unknown_rhythm" : "no_history",
      basis: null,
      runs_sampled: 0,
      per_run_amount: null,
      monthly_amount: null,
      unpriced_models: [],
    };
  const perRun = sample.amount / sample.runs;
  return {
    ...base,
    state: p.runs_per_month === null ? "unknown_rhythm" : "estimated",
    basis,
    runs_sampled: sample.runs,
    per_run_amount: round(perRun, 6),
    monthly_amount: p.runs_per_month === null ? null : round(perRun * p.runs_per_month, 4),
    unpriced_models: [...sample.unpriced_models].sort(),
  };
}
