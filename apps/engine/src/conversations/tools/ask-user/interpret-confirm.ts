// Single source of truth for "did the operator confirm?".
//
// An `ask_user_confirm` answer reaches the engine from several surfaces
// with different JSON shapes:
//   - MCP-native bridge / sk-cli → `{ confirmed: true | false }`
//   - the web portal            → `{ approved: true | false }`
//
// Before this helper existed each reader interpreted the raw shape on
// its own: `recordTransition` (the interaction-log mirror) defaulted to
// "confirmed", while `checkDecline` (the auto-persist write gate)
// required exactly `confirmed === true`. A portal approval of
// `{ approved: true }` was therefore recorded as *confirmed* in the log
// yet treated as *declined* by auto-persist — the operator approved a
// `save_workflow_draft` commit, the write was silently skipped, and the
// LLM was handed a `user_declined` error. Routing every reader through
// this one function makes the two paths impossible to diverge.
//
// Write-safety note: `"ambiguous"` (an answer carrying neither a confirm
// nor a decline signal) is NEVER treated as a confirmation by the write
// gate — auto-persist fires only on an explicit `"confirmed"`. Callers
// that persist a side effect must treat ambiguous as a non-confirmation.

const PLAIN_OBJECT = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export type ConfirmDecision = "confirmed" | "declined" | "ambiguous";

/**
 * Interpret an `ask_user_confirm` answer into a single decision.
 * Recognises both the MCP/sk-cli (`confirmed`) and portal (`approved`)
 * spellings. Decline signals win over confirm signals (an answer that
 * somehow carries both is a decline — the safe reading).
 */
export function interpretConfirmDecision(output: unknown): ConfirmDecision {
  const o = PLAIN_OBJECT(output);
  if (!o) return "ambiguous";
  if (o.confirmed === false || o.declined === true || o.approved === false) return "declined";
  if (o.confirmed === true || o.approved === true) return "confirmed";
  return "ambiguous";
}

/**
 * Canonicalise an `ask_user_confirm` answer so the stored elicitation
 * row, the interaction log, and the auto-persist gate all see the same
 * `{ confirmed: boolean }` shape. Returns the input untouched when the
 * answer is ambiguous (so a malformed confirm is surfaced by
 * `validateElicitationAnswer` rather than coerced) or when it is not a
 * plain object. Any extra fields (`reason`, `tested`, …) are preserved.
 */
export function normalizeConfirmOutput(output: unknown): unknown {
  const decision = interpretConfirmDecision(output);
  if (decision === "ambiguous") return output;
  const o = PLAIN_OBJECT(output) ?? {};
  return { ...o, confirmed: decision === "confirmed" };
}
