import type { ToolCallState } from "@cli-core/index.ts";
import { parseResourceUsage } from "../render/helpers.ts";
import type {
  ConnectorIntent,
  ConnectorSummary,
  WorkflowIntent,
  WorkflowSummary,
  WorkflowTrigger,
} from "../render/types.ts";
import { asRecord, unwrapData } from "./authoring-cards-shared.tsx";

function extractTrigger(raw: unknown): WorkflowTrigger {
  const r = asRecord(raw);
  if (r) {
    if (r.kind === "schedule") {
      return {
        kind: "schedule",
        cron: typeof r.cron === "string" ? r.cron : "?",
        tz: typeof r.tz === "string" ? r.tz : "UTC",
      };
    }
    if (r.kind === "webhook") {
      return {
        kind: "webhook",
        source: typeof r.source === "string" ? r.source : "?",
        events: Array.isArray(r.events) ? r.events.filter((e) => typeof e === "string") : [],
      };
    }
  }
  return { kind: "request" };
}

export function extractWorkflowIntent(call: ToolCallState): WorkflowIntent | null {
  const d = unwrapData(call);
  if (!d) return null;
  const workflow = asRecord(d.workflow) ?? d;
  const definition = asRecord(workflow.definition) ?? asRecord(d.definition);
  const rawSteps =
    (Array.isArray(definition?.steps) && definition?.steps) ||
    (Array.isArray(workflow.steps) && (workflow.steps as unknown[])) ||
    null;
  if (!rawSteps) return null;
  const name =
    typeof workflow.name === "string" ? workflow.name : typeof d.name === "string" ? d.name : null;
  if (!name) return null;
  const steps = rawSteps
    .map((s) => {
      const r = asRecord(s);
      if (!r) return null;
      return {
        key: typeof r.key === "string" ? r.key : typeof r.id === "string" ? r.id : "(step)",
        kind: typeof r.kind === "string" ? r.kind : "step",
        ...(typeof r.connector_slug === "string"
          ? { connector_slug: r.connector_slug as string }
          : {}),
      };
    })
    .filter((s): s is { key: string; kind: string; connector_slug?: string } => s !== null);
  return {
    kind: "workflow",
    name,
    ...(typeof workflow.slug === "string" ? { slug: workflow.slug as string } : {}),
    trigger: extractTrigger(definition?.trigger ?? workflow.trigger),
    steps,
  };
}

export function extractConnectorIntent(call: ToolCallState): ConnectorIntent | null {
  const d = unwrapData(call);
  if (!d) return null;
  const connector = asRecord(d.connector) ?? d;
  const templateSlug =
    typeof connector.template_slug === "string"
      ? connector.template_slug
      : typeof d.template_slug === "string"
        ? d.template_slug
        : null;
  if (!templateSlug) return null;
  const env = connector.environment;
  return {
    kind: "connector",
    template_slug: templateSlug,
    ...(typeof connector.name === "string" ? { name: connector.name as string } : {}),
    ...(env === "dev" || env === "prod" ? { environment: env } : {}),
    ...(typeof connector.auth_type === "string"
      ? { auth_type: connector.auth_type as string }
      : {}),
    ...(typeof connector.base_url === "string" ? { base_url: connector.base_url as string } : {}),
  };
}

export function extractWorkflowSummary(call: ToolCallState): WorkflowSummary | null {
  const d = unwrapData(call);
  if (!d) return null;
  const id = typeof d.workflow_id === "string" ? d.workflow_id : null;
  if (!id) return null;
  const workflow = asRecord(d.workflow) ?? {};
  const name =
    typeof workflow.name === "string" ? workflow.name : typeof d.name === "string" ? d.name : null;
  const version =
    typeof d.version === "number"
      ? d.version
      : typeof workflow.version === "number"
        ? workflow.version
        : null;
  if (!name || version === null) return null;
  const definition = asRecord(workflow.definition) ?? asRecord(d.definition) ?? {};
  const usage = parseResourceUsage(d.usage);
  return {
    kind: "workflow",
    id,
    version,
    name,
    trigger: extractTrigger(definition.trigger),
    ...(usage ? { usage } : {}),
  };
}

export function extractConnectorSummary(call: ToolCallState): ConnectorSummary | null {
  const d = unwrapData(call);
  if (!d) return null;
  const connector = asRecord(d.connector);
  if (!connector) return null;
  const id = typeof connector.id === "string" ? connector.id : null;
  const slug = typeof connector.slug === "string" ? connector.slug : null;
  const templateSlug = typeof connector.template_slug === "string" ? connector.template_slug : null;
  if (!id || !slug || !templateSlug) return null;
  const usage = parseResourceUsage(d.usage);
  return { kind: "connector", id, slug, template_slug: templateSlug, ...(usage ? { usage } : {}) };
}

export interface CollectedItem {
  id: string;
  title: string;
  category: string | null;
}

export function extractCollectedItem(call: ToolCallState): CollectedItem | null {
  const d = unwrapData(call);
  if (d?.collected !== true) return null;
  const item = asRecord(d.intake_item);
  if (!item) return null;
  const id = typeof item.id === "string" ? item.id : null;
  const title = typeof item.title === "string" ? item.title : null;
  if (!id || !title) return null;
  return { id, title, category: typeof item.category === "string" ? item.category : null };
}
