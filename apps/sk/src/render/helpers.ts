import type { AnyIntent } from "./intent-card.tsx";
import type { AnySummary } from "./summary-card.tsx";
import type {
  ConnectorIntent,
  ConnectorSummary,
  KnowledgeSourceIntent,
  KnowledgeSourceSummary,
  ResourceUsage,
  UsageAccessEntry,
  WorkflowIntent,
  WorkflowSummary,
  WorkflowTrigger,
} from "./types.ts";

export const SEPARATOR = "─────────────────────────────";

export function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return `${n}B`;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const s = v >= 10 || i === 0 || Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1);
  return `${s}${units[i]}`;
}

export function triggerLine(trigger: WorkflowTrigger): string {
  if (trigger.kind === "schedule") return `schedule cron=${trigger.cron} tz=${trigger.tz}`;
  if (trigger.kind === "webhook") {
    const evs = trigger.events.length > 0 ? trigger.events.join(",") : "*";
    return `webhook source=${trigger.source} events=${evs}`;
  }
  return "request";
}

export function isWorkflowIntent(i: AnyIntent): i is WorkflowIntent {
  return i.kind === "workflow";
}
export function isKnowledgeSourceIntent(i: AnyIntent): i is KnowledgeSourceIntent {
  return i.kind === "knowledge_source";
}
export function isConnectorIntent(i: AnyIntent): i is ConnectorIntent {
  return i.kind === "connector";
}

export function connectorHeading(intent: ConnectorIntent): string {
  if (intent.name && intent.template_slug) return `${intent.name} (${intent.template_slug})`;
  return intent.name ?? intent.template_slug ?? "(unnamed)";
}

export function connectorTemplateSuffix(summary: ConnectorSummary): string {
  return summary.template_slug ? ` · template=${summary.template_slug}` : "";
}

export function parseResourceUsage(raw: unknown): ResourceUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  if (typeof u.follow_up !== "string" || !Array.isArray(u.access)) return null;
  const access: UsageAccessEntry[] = [];
  for (const entry of u.access) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.via !== "string" || typeof e.label !== "string") continue;
    access.push({
      via: e.via,
      label: e.label,
      ...(typeof e.command === "string" ? { command: e.command } : {}),
      ...(typeof e.url === "string" ? { url: e.url } : {}),
      ...(typeof e.tool === "string" ? { tool: e.tool } : {}),
      ...(typeof e.detail === "string" ? { detail: e.detail } : {}),
    });
  }
  const inputs: ResourceUsage["inputs"] = [];
  if (Array.isArray(u.inputs)) {
    for (const entry of u.inputs) {
      if (!entry || typeof entry !== "object") continue;
      const i = entry as Record<string, unknown>;
      if (typeof i.name !== "string") continue;
      inputs.push({
        name: i.name,
        type: typeof i.type === "string" ? i.type : "string",
        required: i.required === true,
      });
    }
  }
  return {
    inputs,
    output: typeof u.output === "string" ? u.output : null,
    access,
    follow_up: u.follow_up,
  };
}

export function isWorkflowSummary(s: AnySummary): s is WorkflowSummary {
  return s.kind === "workflow";
}
export function isKnowledgeSourceSummary(s: AnySummary): s is KnowledgeSourceSummary {
  return s.kind === "knowledge_source";
}
export function isConnectorSummary(s: AnySummary): s is ConnectorSummary {
  return s.kind === "connector";
}
