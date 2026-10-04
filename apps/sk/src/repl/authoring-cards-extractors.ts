import type { ToolCallState } from "@cli-core/index.ts";
import { parseResourceUsage } from "../render/helpers.ts";
import type {
  ConnectorIntent,
  ConnectorSummary,
  KnowledgeSourceSummary,
  WorkflowIntent,
  WorkflowSummary,
  WorkflowTrigger,
} from "../render/types.ts";
import { asRecord, unwrapData } from "./authoring-cards-shared.tsx";

// Safe extractors — return a typed Intent/Summary built from the tool
// payload, or null when the shape doesn't match. Callers fall back to
// the compact cards on null.
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

// Dual-shape fallback: `save_workflow_draft` returns `{ workflow_id,
// workflow: { name, version, definition } }` (the canonical wrapper),
// but several engine paths — older save-result payloads and the
// commit-result card lifecycle — emit `name`/`version` flat on the
// top-level data object alongside `workflow_id`. We accept both so the
// REPL renders a Summary card from either; the wrapper is preferred
// when present. See `extractWorkflowIntent` for the matching read of
// `definition.steps` vs `workflow.steps`. Until the engine narrows to
// a single shape across all call sites, this dual read is intentional.
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

// create_knowledge_source returns
//   { created: true, knowledge_source: { id, name, slug, scope, status,
//     chunk_count, bytes_total, mime_type?, filename? }, audit_log_id }
// The tool response carries the resolved `mime_type` (nullable) and
// `filename` so the card shows the real content_type (`text/markdown`
// for an .md upload) instead of a hardcoded fallback.
// `file_id` is still read from args (engine never echoes it).
export function extractKnowledgeSourceSummary(call: ToolCallState): KnowledgeSourceSummary | null {
  const d = unwrapData(call);
  if (!d) return null;
  const ks = asRecord(d.knowledge_source);
  if (!ks) return null;
  const id = typeof ks.id === "string" ? ks.id : null;
  const name = typeof ks.name === "string" ? ks.name : null;
  if (!id || !name) return null;
  const bytes_total = typeof ks.bytes_total === "number" ? ks.bytes_total : 0;
  const args = asRecord(call.args) ?? {};
  const argMime = typeof args.mime_type === "string" ? args.mime_type : null;
  const argFileId = typeof args.file_id === "string" ? args.file_id : null;
  // Resolution order: engine-echoed mime_type (authoritative) →
  // args.mime_type (set explicitly in inline mode) → mode-derived
  // default. The from_attachment branch falls back to
  // `application/octet-stream` only when the stored row has no MIME.
  // Coerce empty strings to null so the `??` chain falls through to
  // the next tier. Pre-fix `??` only treated nullish as missing, so an
  // engine that ever returned `mime_type: ""` would surface as an
  // empty content-type label in the card.
  const resMime = typeof ks.mime_type === "string" && ks.mime_type.length > 0 ? ks.mime_type : null;
  const argMimeNonEmpty = argMime && argMime.length > 0 ? argMime : null;
  const mime_type =
    resMime ??
    argMimeNonEmpty ??
    (args.mode === "inline" ? "text/markdown" : "application/octet-stream");
  const usage = parseResourceUsage(d.usage);
  return {
    kind: "knowledge_source",
    id,
    name,
    mime_type,
    size_bytes: bytes_total,
    ...(argFileId ? { file_id: argFileId } : {}),
    ...(usage ? { usage } : {}),
  };
}
