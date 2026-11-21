export interface WorkSteps {
  used: number;
  total: number;
}

export function workSteps(
  turnsUsed: number | null | undefined,
  maxTurns: number | null | undefined,
): WorkSteps | null {
  if (turnsUsed === null || turnsUsed === undefined) return null;
  if (!maxTurns || maxTurns <= 0) return null;
  const used = Math.max(0, Math.min(Math.floor(turnsUsed), maxTurns));
  return { used, total: maxTurns };
}
