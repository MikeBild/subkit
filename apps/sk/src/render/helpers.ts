// Shared render helpers — trigger-line formatter and the type guards
// used by both `intent-card.tsx` and `summary-card.tsx` (TTY) and
// `index.ts` (plain-text fallback). Centralised so a new variant (e.g.
// adding a `KnowledgeSourceSummary` shape) is touched in exactly one
// place instead of three.

import type { AnyIntent } from "./intent-card.tsx";
import type { AnySummary } from "./summary-card.tsx";
import type {
  ConnectorIntent,
  ConnectorSummary,
  KnowledgeSourceIntent,
  KnowledgeSourceSummary,
  WorkflowIntent,
  WorkflowSummary,
  WorkflowTrigger,
} from "./types.ts";

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

export function isWorkflowSummary(s: AnySummary): s is WorkflowSummary {
  return s.kind === "workflow";
}
export function isKnowledgeSourceSummary(s: AnySummary): s is KnowledgeSourceSummary {
  return s.kind === "knowledge_source";
}
export function isConnectorSummary(s: AnySummary): s is ConnectorSummary {
  return s.kind === "connector";
}
