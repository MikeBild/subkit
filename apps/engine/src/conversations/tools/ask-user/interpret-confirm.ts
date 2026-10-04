const PLAIN_OBJECT = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export type ConfirmDecision = "confirmed" | "declined" | "ambiguous";

export function interpretConfirmDecision(output: unknown): ConfirmDecision {
  const o = PLAIN_OBJECT(output);
  if (!o) return "ambiguous";
  if (o.confirmed === false || o.declined === true || o.approved === false) return "declined";
  if (o.confirmed === true || o.approved === true) return "confirmed";
  return "ambiguous";
}

export function normalizeConfirmOutput(output: unknown): unknown {
  const decision = interpretConfirmDecision(output);
  if (decision === "ambiguous") return output;
  const o = PLAIN_OBJECT(output) ?? {};
  return { ...o, confirmed: decision === "confirmed" };
}
