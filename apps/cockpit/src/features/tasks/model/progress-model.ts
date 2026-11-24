export interface RoundBudget {
  used: number;
  total: number;
}

export function roundBudget(
  turnsUsed: number | null | undefined,
  maxTurns: number | null | undefined,
): RoundBudget | null {
  if (turnsUsed === null || turnsUsed === undefined) return null;
  if (!maxTurns || maxTurns <= 0) return null;
  const used = Math.max(0, Math.min(Math.floor(turnsUsed), maxTurns));
  return { used, total: maxTurns };
}
