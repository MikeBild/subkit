import pc from "picocolors";
import type {
  AttentionItem,
  EngineClient,
  FailureOrigin,
  OperatorHealthDigest,
  RiskSeverity,
} from "../engine-client.ts";

export const FAILURE_ORIGIN_LABEL: Record<FailureOrigin, string> = {
  authoring: "authoring",
  manual: "test run",
  scheduled: "scheduled",
  mixed: "mixed",
};

export function totalFailureCount(digest: OperatorHealthDigest): number {
  return digest.failure_groups.reduce((acc, g) => acc + g.count, 0);
}

async function readOperatorDigest(client: EngineClient): Promise<OperatorHealthDigest | null> {
  try {
    const digest = await client.getOperatorHealthDigest();
    return { ...digest, risk: digest.risk ?? [] };
  } catch {
    return null;
  }
}

export async function fetchOperatorDigest(
  client: EngineClient,
): Promise<OperatorHealthDigest | null> {
  const digest = await readOperatorDigest(client);
  return digest && !digest.all_clear ? digest : null;
}

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

export function unreadAttentionSources(digest: OperatorHealthDigest): string[] {
  return Object.entries(digest.attention.sources)
    .filter(([, state]) => state === "failed")
    .map(([source]) => source);
}

const RISK_COLOR: Record<RiskSeverity, (s: string) => string> = {
  critical: pc.red,
  warn: pc.yellow,
};

export async function riskSummaryLine(client: EngineClient): Promise<string | null> {
  const digest = await readOperatorDigest(client);
  if (!digest || digest.risk.length === 0) return null;
  const top = digest.risk[0]!;
  const color = RISK_COLOR[top.severity];
  const more = digest.risk.length > 1 ? pc.dim(` (+${digest.risk.length - 1} more)`) : "";
  return `${color("●")} ${color(`[${top.severity}]`)} ${top.headline}${more}`;
}

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
