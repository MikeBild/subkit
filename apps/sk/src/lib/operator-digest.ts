// Startup operator digest for the `sk` REPL.
//
// The engine computes a deterministic health digest (failed runs grouped
// by root cause + tagged by origin, plus self-healing fixes awaiting
// review). At REPL open we fetch it once: the structured digest is
// rendered as in-context chrome by repl/needs-attention-panel.tsx, and
// folded into the first turn's memory via digestAsContext so the injected
// "guided triage" starter action grounds the LLM in the same issues.
// Best-effort: any failure here must never block the REPL.

import pc from "picocolors";
import type {
  AttentionItem,
  EngineClient,
  FailureOrigin,
  OperatorHealthDigest,
  RiskSeverity,
} from "../engine-client.ts";

/** Friendly label per failure origin. Shared by the needs-attention panel so
 *  the chrome and any future context render stay in sync. */
export const FAILURE_ORIGIN_LABEL: Record<FailureOrigin, string> = {
  authoring: "authoring",
  manual: "test run",
  scheduled: "scheduled",
  mixed: "mixed",
};

/** Total failing runs across all groups (sum of per-group counts). The single
 *  source for both the panel header and the guided-triage starter label so the
 *  two can never drift. */
export function totalFailureCount(digest: OperatorHealthDigest): number {
  return digest.failure_groups.reduce((acc, g) => acc + g.count, 0);
}

/**
 * The digest, normalized — or null only when the engine could not be read.
 * `all_clear` answers "does anything need a person now"; it does not mean
 * the digest is empty (a warning trend is still in `risk`).
 */
export async function readOperatorDigest(
  client: EngineClient,
): Promise<OperatorHealthDigest | null> {
  try {
    const digest = await client.getOperatorHealthDigest();
    // Normalize at the chokepoint: an engine older than the risk[] field (a
    // rolling-deploy version skew) omits `risk`, and every caller reads
    // `digest.risk.length` outside a guard. Default to [] here so the chrome
    // / context render can never throw on a missing field.
    return { ...digest, risk: digest.risk ?? [] };
  } catch {
    return null;
  }
}

/** The digest the REPL shows at startup: null when nothing needs attention. */
export async function fetchOperatorDigest(
  client: EngineClient,
): Promise<OperatorHealthDigest | null> {
  const digest = await readOperatorDigest(client);
  return digest && !digest.all_clear ? digest : null;
}

/**
 * One attention item as a line: what, why, and where it is acted on — the
 * engine's machine reason, with the counts behind it and the primary action's
 * address.
 */
export function attentionItemLine(item: AttentionItem): string {
  const subject = item.subject
    ? `${item.subject.kind} ${item.subject.name ?? item.subject.id}`
    : item.kind.replace(/_/g, " ");
  const counts = [
    item.counts.failures
      ? `${item.counts.failures} failure${item.counts.failures === 1 ? "" : "s"}`
      : null,
    item.counts.patches
      ? `${item.counts.patches} fix${item.counts.patches === 1 ? "" : "es"}`
      : null,
    item.counts.skills
      ? `${item.counts.skills} skill proposal${item.counts.skills === 1 ? "" : "s"}`
      : null,
  ].filter((part): part is string => part !== null);
  const primary = item.actions.find((action) => action.primary);
  return [
    `[${item.class}] ${subject}: ${item.reason.replace(/_/g, " ")}`,
    counts.length > 0 ? ` (${counts.join(", ")})` : "",
    primary ? ` → ${primary.verb.replace(/_/g, " ")} at ${primary.href}` : "",
  ].join("");
}

/** The attention sources the engine could not read — never to be taken as empty. */
export function unreadAttentionSources(digest: OperatorHealthDigest): string[] {
  return Object.entries(digest.attention.sources)
    .filter(([, state]) => state === "failed")
    .map(([source]) => source);
}

/** Severity → terminal color. Critical leads in red (same weight as a
 *  scheduled production failure); warn is yellow. */
const RISK_COLOR: Record<RiskSeverity, (s: string) => string> = {
  critical: pc.red,
  warn: pc.yellow,
};

/** Best-effort one-line risk summary for the `sk login` success path. Fetches
 *  the digest, returns a single severity-colored line naming the top risk and
 *  any others, or null when there's nothing to flag / the engine is
 *  unreachable. Never throws — login must never block on this. */
export async function riskSummaryLine(client: EngineClient): Promise<string | null> {
  // The normalized read (risk ?? [], null only when unreachable) — NOT the
  // REPL's startup fetch: a warning trend is worth this line even when nothing
  // needs acting on, which is exactly when `all_clear` is true.
  const digest = await readOperatorDigest(client);
  if (!digest || digest.risk.length === 0) return null;
  const top = digest.risk[0]!;
  const color = RISK_COLOR[top.severity];
  const more = digest.risk.length > 1 ? pc.dim(` (+${digest.risk.length - 1} more)`) : "";
  return `${color("●")} ${color(`[${top.severity}]`)} ${top.headline}${more}`;
}

/** Plain-text context block folded into the first turn's memory so the
 *  LLM can act on the same issues the operator just saw. */
export function digestAsContext(digest: OperatorHealthDigest): string {
  const parts: string[] = [
    "## Operator health digest (engine-computed, deterministic)",
    "",
    `As of ${digest.generated_at}, scanning the last ${digest.window_hours}h:`,
    digest.headline,
    "",
  ];
  const attention = digest.attention;
  if (attention.items.length > 0) {
    parts.push("Needs attention now (one line per item; act at the address named):");
    for (const item of attention.items) parts.push(`- ${attentionItemLine(item)}`);
    parts.push("");
  }
  const unread = unreadAttentionSources(digest);
  if (unread.length > 0) {
    parts.push(
      `Could not be read: ${unread.join(", ")}. Do not tell the operator these are clear.`,
      "",
    );
  }
  if (digest.failure_groups.length > 0) {
    parts.push("Failing runs (grouped by root cause):");
    for (const g of digest.failure_groups) {
      const label = g.workflow_name ?? g.workflow_id ?? "(draft)";
      parts.push(
        `- [${g.origin}] ${label} · step ${g.step_key ?? "?"} · ${g.error_code ?? "?"} · ${g.count}× — ${g.cause}`,
      );
    }
    parts.push("");
  }
  if (digest.patch_candidates.open > 0) {
    parts.push("Self-healing fixes awaiting review:");
    for (const p of digest.patch_candidates.items) {
      const label = p.workflow_name ?? p.workflow_id ?? "(workflow)";
      parts.push(`- ${p.id} · ${label} · [${p.classification}] — ${p.summary}`);
    }
    parts.push("");
  }
  if (digest.risk.length > 0) {
    parts.push("Risk signals (leading indicators, engine-computed):");
    for (const r of digest.risk) {
      parts.push(
        `- [${r.severity}] ${r.kind} · ${r.headline} (${r.metric}=${r.value}, threshold ${r.threshold}) — ${r.detail}`,
      );
    }
    parts.push("");
  }
  parts.push(
    "If the operator asks to fix or review these, use the execution/patch-candidate tools to diagnose and act, or point at the address an item names. Do not invent issues beyond this digest.",
  );
  return parts.join("\n");
}
