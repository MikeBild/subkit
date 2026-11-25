import type { Db } from "../db/index.ts";
import { logger } from "../logging/index.ts";
import { readConfirmationFacts } from "./persistence/confirmations.ts";

export const CONFIRMATION_OUTCOMES = [
  "granted",
  "declined",
  "expired",
  "superseded",
  "cancelled",
  "open",
] as const;
export type ConfirmationOutcome = (typeof CONFIRMATION_OUTCOMES)[number];

export const CONFIRMATION_COVERS = ["rule", "instruction", "authority"] as const;
export type ConfirmationCover = (typeof CONFIRMATION_COVERS)[number];

export const CONFIRMATION_KINDS = ["policy_gate", "ask_user"] as const;
export type ConfirmationKind = (typeof CONFIRMATION_KINDS)[number];

const COVER_BY_REASON: Readonly<Record<string, ConfirmationCover>> = {
  standing_rule: "rule",
  user_instruction: "instruction",
  authority_covered: "authority",
};

export interface ConfirmationAskRow {
  tool: string;
  kind: ConfirmationKind;
  outcome: ConfirmationOutcome;
  in_task_run: boolean;
  asked: number;
}

export interface ConfirmationCoverRow {
  tool: string;
  reason: string;
  covered: number;
}

export interface ConfirmationToolFigures {
  tool: string;
  asked: number;
  asked_in_task_runs: number;
  outcomes: Record<ConfirmationOutcome, number>;
  covered: Record<ConfirmationCover, number>;
}

export interface ConfirmationFigures {
  asked: number;
  covered: number;
  kinds: Record<ConfirmationKind, number>;
  outcomes: Record<ConfirmationOutcome, number>;
  covered_by: Record<ConfirmationCover, number>;
  per_turn: { turns: number; turns_with_ask: number; asked_per_turn: number | null };
  per_task_run: {
    runs: number;
    runs_with_ask: number;
    asked: number;
    asked_per_run: number | null;
    median_per_run: number | null;
  };
  tools: ConfirmationToolFigures[];
}

export interface ConfirmationFacts {
  asks: readonly ConfirmationAskRow[];
  covers: readonly ConfirmationCoverRow[];
  turns: number;
  turns_with_ask: number;
  asks_per_run: readonly number[];
}

const zeroed = <K extends string>(keys: readonly K[]): Record<K, number> =>
  Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;

const ratio = (part: number, whole: number): number | null =>
  whole > 0 ? Math.round((part / whole) * 100) / 100 : null;

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export function summarizeConfirmations(facts: ConfirmationFacts): ConfirmationFigures {
  const tools = new Map<string, ConfirmationToolFigures>();
  const toolOf = (tool: string): ConfirmationToolFigures => {
    const known = tools.get(tool);
    if (known) return known;
    const fresh: ConfirmationToolFigures = {
      tool,
      asked: 0,
      asked_in_task_runs: 0,
      outcomes: zeroed(CONFIRMATION_OUTCOMES),
      covered: zeroed(CONFIRMATION_COVERS),
    };
    tools.set(tool, fresh);
    return fresh;
  };
  const kinds = zeroed(CONFIRMATION_KINDS);
  const outcomes = zeroed(CONFIRMATION_OUTCOMES);
  const coveredBy = zeroed(CONFIRMATION_COVERS);
  let asked = 0;
  for (const row of facts.asks) {
    const figures = toolOf(row.tool);
    figures.asked += row.asked;
    figures.outcomes[row.outcome] += row.asked;
    if (row.in_task_run) figures.asked_in_task_runs += row.asked;
    kinds[row.kind] += row.asked;
    outcomes[row.outcome] += row.asked;
    asked += row.asked;
  }
  let covered = 0;
  for (const row of facts.covers) {
    const cover = COVER_BY_REASON[row.reason];
    if (!cover) continue;
    toolOf(row.tool).covered[cover] += row.covered;
    coveredBy[cover] += row.covered;
    covered += row.covered;
  }
  const runAsked = facts.asks_per_run.reduce((total, count) => total + count, 0);
  return {
    asked,
    covered,
    kinds,
    outcomes,
    covered_by: coveredBy,
    per_turn: {
      turns: facts.turns,
      turns_with_ask: facts.turns_with_ask,
      asked_per_turn: ratio(asked, facts.turns),
    },
    per_task_run: {
      runs: facts.asks_per_run.length,
      runs_with_ask: facts.asks_per_run.filter((count) => count > 0).length,
      asked: runAsked,
      asked_per_run: ratio(runAsked, facts.asks_per_run.length),
      median_per_run: median(facts.asks_per_run),
    },
    tools: [...tools.values()].sort(
      (left, right) =>
        right.asked - left.asked ||
        CONFIRMATION_COVERS.reduce((sum, key) => sum + right.covered[key] - left.covered[key], 0) ||
        left.tool.localeCompare(right.tool),
    ),
  };
}

export async function aggregateConfirmations(
  db: Db,
  params: { tenantId: string; from: Date; to: Date },
): Promise<ConfirmationFigures> {
  const figures = summarizeConfirmations(await readConfirmationFacts(db, params));
  logger.debug({
    module: "stats",
    action: "stats.confirmations_read",
    msg: "aggregated confirmation asks per turn and per task run",
    tenant_id: params.tenantId,
    from: params.from.toISOString(),
    to: params.to.toISOString(),
    asked: figures.asked,
    covered: figures.covered,
    turns: figures.per_turn.turns,
    task_runs: figures.per_task_run.runs,
  });
  return figures;
}
