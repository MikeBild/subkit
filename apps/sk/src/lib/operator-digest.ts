// Startup operator digest for the `sk` REPL.
//
// The engine computes a deterministic health digest (failed runs grouped
// by root cause + tagged by origin, plus self-healing fixes awaiting
// review). At REPL open we fetch it once and render it as a colored,
// assistant-voiced block — subkit speaking first — then offer to walk
// through the fixes. The structured digest is also folded into the first
// turn's memory so replying "yes" actually grounds the LLM in the same
// issues. Best-effort: any failure here must never block the REPL.

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

const ORIGIN_LABEL: Record<string, string> = {
  authoring: "authoring",
  manual: "test run",
  scheduled: "scheduled",
  mixed: "mixed",
};

/** Colored, assistant-voiced render for the terminal. Scheduled failures
 *  (real production incidents) lead in red; authoring/manual trial-runs
 *  are yellow; self-healing fixes are cyan. */
export function renderDigestBanner(digest: OperatorHealthDigest): string {
  const lines: string[] = [];
  lines.push(pc.bold(pc.cyan("subkit")) + pc.dim("  ·  startup health check"));
  lines.push("");

  const scheduled = digest.failure_groups.filter((g) => g.origin === "scheduled");
  const headlineColor = scheduled.length > 0 ? pc.red : pc.yellow;
  lines.push(headlineColor(`I noticed a few things since we last talked — ${digest.headline}`));
  lines.push("");

  for (const g of digest.failure_groups) {
    const sev = g.origin === "scheduled" ? pc.red : pc.yellow;
    const label = g.workflow_name ?? g.workflow_id ?? "(draft)";
    const tag = pc.dim(`[${ORIGIN_LABEL[g.origin] ?? g.origin}]`);
    const times = g.count === 1 ? "failed once" : `failed ${g.count}×`;
    lines.push(`  ${sev("●")} ${tag} ${pc.bold(label)} — ${times}`);
    lines.push(`      ${pc.dim(g.cause)}`);
  }

  if (digest.patch_candidates.pending > 0) {
    lines.push("");
    const n = digest.patch_candidates.pending;
    lines.push(pc.cyan(`  ${n} self-healing fix${n === 1 ? "" : "es"} awaiting your review:`));
    for (const p of digest.patch_candidates.items.slice(0, 5)) {
      const label = p.workflow_name ?? p.workflow_id ?? "(workflow)";
      lines.push(
        `      ${pc.cyan("•")} ${pc.bold(label)} ${pc.dim(`[${p.classification}]`)} — ${p.summary}`,
      );
    }
  }

  // Leading-indicator risk signals — the things trending toward an incident
  // that haven't failed a run yet. Severity-colored so a critical stands out.
  if (digest.risk.length > 0) {
    lines.push("");
    lines.push(pc.bold("  Risk signals") + pc.dim("  (leading indicators):"));
    for (const r of digest.risk) {
      const color = RISK_COLOR[r.severity];
      lines.push(`      ${color("●")} ${color(`[${r.severity}]`)} ${pc.bold(r.headline)}`);
      lines.push(`        ${pc.dim(r.detail)}`);
    }
  }

  lines.push("");
  lines.push(
    pc.dim("  Want me to walk through fixes? Reply ") +
      pc.bold("yes") +
      pc.dim(" — or just start typing."),
  );
  return lines.join("\n");
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
