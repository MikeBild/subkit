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
import type { EngineClient, OperatorHealthDigest, RiskSeverity } from "../engine-client.ts";

export async function fetchOperatorDigest(
  client: EngineClient,
): Promise<OperatorHealthDigest | null> {
  try {
    const digest = await client.getOperatorHealthDigest();
    if (digest.all_clear) return null;
    // Normalize at the chokepoint: an engine older than the risk[] field (a
    // rolling-deploy version skew) omits `risk`, and every caller reads
    // `digest.risk.length` outside a guard. Default to [] here so the REPL
    // banner / context render can never throw on a missing field.
    return { ...digest, risk: digest.risk ?? [] };
  } catch {
    return null;
  }
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
  // Reuse the normalized fetch (risk ?? [], null on all-clear/unreachable) so a
  // version-skewed engine without `risk` can't reach a raw `.length`.
  const digest = await fetchOperatorDigest(client);
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
  if (digest.patch_candidates.pending > 0) {
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
    "If the operator asks to fix or review these, use the execution/patch-candidate tools to diagnose and act. Do not invent issues beyond this digest.",
  );
  return parts.join("\n");
}
