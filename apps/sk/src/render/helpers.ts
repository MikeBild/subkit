// Shared render helpers — trigger-line formatter, type guards, and the
// pure formatters used by both `intent-card.tsx` / `summary-card.tsx`
// (TTY) and `index.ts` (plain-text fallback). Centralised so a new
// variant (e.g. adding a `KnowledgeSourceSummary` shape) is touched in
// exactly one place instead of three.

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

// The dashed separator the workflow `create` flow draws above its
// task-list. Lives here so both the TTY card (`task-list.tsx`) and the
// plain-text fallback (`index.ts`) draw the identical glyph instead of
// drifting on width or character class.
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

/**
 * Headline for a connector intent, for both the TTY card and the plain
 * fallback.
 *
 * Three shapes, because a connector may be authored from a template, from a
 * definition file (no template at all), or from a template before its name is
 * known. Interpolating `template_slug` unconditionally printed
 * `Loop MCP (undefined)` for the file path.
 */
export function connectorHeading(intent: ConnectorIntent): string {
  if (intent.name && intent.template_slug) return `${intent.name} (${intent.template_slug})`;
  return intent.name ?? intent.template_slug ?? "(unnamed)";
}

/** Trailing ` · template=<slug>` for a connector summary, empty when the
 *  connector was authored from a file and has no template. */
export function connectorTemplateSuffix(summary: ConnectorSummary): string {
  return summary.template_slug ? ` · template=${summary.template_slug}` : "";
}

/**
 * Defensive parse of the engine's `data.usage` persist-envelope payload
 * into the render shape. Returns null when the shape doesn't match — the
 * summary card then renders without the usage block (degenerate envelope,
 * not a compat path).
 */
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
