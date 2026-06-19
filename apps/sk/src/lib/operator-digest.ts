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
import type { EngineClient, OperatorHealthDigest } from "../engine-client.ts";

export async function fetchOperatorDigest(
  client: EngineClient,
): Promise<OperatorHealthDigest | null> {
  try {
    const digest = await client.getOperatorHealthDigest();
    return digest.all_clear ? null : digest;
  } catch {
    return null;
  }
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
  parts.push(
    "If the operator asks to fix or review these, use the execution/patch-candidate tools to diagnose and act. Do not invent issues beyond this digest.",
  );
  return parts.join("\n");
}
