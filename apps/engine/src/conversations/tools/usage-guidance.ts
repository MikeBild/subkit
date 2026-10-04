import { getConfig } from "../../config/loader.ts";
import type { Db } from "../../db/client.ts";
import { listSchedules } from "../../scheduler/repo.ts";
import { listInbound } from "../../webhooks/inbound/service.ts";
import { synthesizeInputSchema } from "../../workflows/input-schema-synth.ts";
import type { WorkflowDef } from "../../workflows/types.ts";

export interface UsageAccessEntry {
  via: "rest" | "schedule" | "webhook" | "mcp" | "chat" | "cli";
  label: string;
  command?: string;
  url?: string;
  tool?: string;
  detail?: string;
}

export interface UsageInputEntry {
  name: string;
  type: string;
  required: boolean;
}

export interface FollowUpOption {
  label: string;
  value: string;
  detail?: string;
}

export interface ResourceUsage {
  kind: "workflow" | "connector" | "knowledge_source";
  slug: string;
  name: string;
  summary: string | null;
  inputs: UsageInputEntry[];
  output: string | null;
  access: UsageAccessEntry[];
  follow_up: string;
  follow_up_options?: FollowUpOption[];
}

export interface WorkflowDefinitionLike {
  description?: string | undefined;
  input_schema?: Record<string, unknown> | undefined;
  output_schema?: Record<string, unknown> | undefined;
  output_transform?: string | undefined;
  steps: ReadonlyArray<unknown>;
}

export interface WorkflowUsageParts {
  workflow: {
    id: string;
    slug: string;
    name: string;
    definition: WorkflowDefinitionLike;
  };
  schedules: Array<{ cron: string; timezone: string; paused: boolean }>;
  inboundHooks: Array<{ slug: string }>;
  publicBaseUrl: string | null;
}

export function resolvePublicBaseUrl(): string | null {
  try {
    const cfg = getConfig().server.public_base_url;
    if (cfg && cfg.length > 0) return cfg.endsWith("/") ? cfg.slice(0, -1) : cfg;
  } catch {}
  return null;
}

function inputsFromSchema(schema: Record<string, unknown> | null): UsageInputEntry[] {
  if (!schema || typeof schema !== "object") return [];
  const properties = schema.properties;
  if (!properties || typeof properties !== "object") return [];
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  return Object.entries(properties as Record<string, unknown>).map(([name, prop]) => {
    const type =
      prop && typeof prop === "object" && typeof (prop as { type?: unknown }).type === "string"
        ? ((prop as { type: string }).type ?? "string")
        : "string";
    return { name, type, required: required.has(name) };
  });
}

function workflowOutputLine(def: WorkflowDefinitionLike): string | null {
  if (def.output_transform) return "shaped by the workflow's output transform";
  const rawLast = def.steps[def.steps.length - 1];
  if (!rawLast || typeof rawLast !== "object") return null;
  const last = rawLast as { id?: unknown; kind?: unknown };
  const id = typeof last.id === "string" ? last.id : null;
  const kind = typeof last.kind === "string" ? last.kind : null;
  if (!id && !kind) return null;
  return `raw result of the last step${id ? ` \`${id}\`` : ""}${kind ? ` (${kind})` : ""}`;
}

export function buildWorkflowUsageFromParts(p: WorkflowUsageParts): ResourceUsage {
  const { workflow, schedules, inboundHooks, publicBaseUrl } = p;
  const def = workflow.definition;
  const schema =
    def.input_schema ??
    (synthesizeInputSchema(def as unknown as WorkflowDef) as Record<string, unknown> | null);
  const inputs = inputsFromSchema(schema ?? null);
  const inputHint = inputs.length > 0 ? ` ${inputs.map((i) => `${i.name}=<value>`).join(" ")}` : "";
  const restBody = {
    source: "saved",
    workflow_id: workflow.id,
    ...(inputs.length > 0
      ? {
          input: Object.fromEntries(
            inputs.map((input) => [input.name, input.required ? `<${input.name}>` : null]),
          ),
        }
      : { input: {} }),
  };
  const restPath = "/v1/executions";
  const restUrl = publicBaseUrl ? `${publicBaseUrl}${restPath}` : restPath;

  const access: UsageAccessEntry[] = [
    {
      via: "cli",
      label: "sk CLI",
      command: `sk workflows run ${workflow.slug}${inputHint}`,
    },
    {
      via: "mcp",
      label: "MCP tool",
      tool: `wf_${workflow.slug}`,
      detail: "available to connected MCP clients (claude.ai, Cursor, …)",
    },
    {
      via: "chat",
      label: "Chat",
      command: `/subkit run ${workflow.slug}${inputHint}`,
    },
    {
      via: "rest",
      label: "REST API",
      command: `POST ${restUrl}`,
      ...(publicBaseUrl ? { url: restUrl } : {}),
      detail: `body: ${JSON.stringify(restBody)}`,
    },
  ];

  const liveSchedules = schedules.filter((s) => !s.paused);
  if (liveSchedules.length > 0) {
    for (const s of liveSchedules) {
      access.push({
        via: "schedule",
        label: "Schedule (live)",
        detail: `${s.cron} (${s.timezone})`,
      });
    }
  } else {
    access.push({
      via: "schedule",
      label: "Schedule",
      command: `create_schedule(workflow_id: "${workflow.id}", cron: "0 9 * * 1-5")`,
      detail: "not scheduled yet — bind a cron or every:<seconds> cadence",
    });
  }

  for (const hook of inboundHooks) {
    access.push({
      via: "webhook",
      label: "Inbound webhook",
      command: `POST ${publicBaseUrl ?? ""}/v1/hooks/${hook.slug}`,
      ...(publicBaseUrl ? { url: `${publicBaseUrl}/v1/hooks/${hook.slug}` } : {}),
    });
  }

  const follow_up_options: FollowUpOption[] = access
    .filter((e) => e.via !== "webhook")
    .reduce<FollowUpOption[]>((acc, e) => {
      if (acc.some((o) => o.value === e.via)) return acc;
      const optDetail = e.command ?? e.tool ?? e.detail;
      const opt: FollowUpOption = { label: e.label, value: e.via };
      if (optDetail !== undefined) opt.detail = optDetail;
      acc.push(opt);
      return acc;
    }, []);

  return {
    kind: "workflow",
    slug: workflow.slug,
    name: workflow.name,
    summary: def.description ?? null,
    inputs,
    output: workflowOutputLine(def),
    access,
    follow_up: "Run it now, show the REST/HTTP call, or set up a schedule?",
    follow_up_options,
  };
}

export async function buildWorkflowUsage(
  db: Db,
  tenant_id: string,
  workflow: { id: string; slug: string; name: string; definition: WorkflowDefinitionLike },
): Promise<ResourceUsage> {
  const [scheduleList, hooks] = await Promise.all([
    listSchedules(db, tenant_id, workflow.id),
    listInbound(tenant_id, db),
  ]);
  return buildWorkflowUsageFromParts({
    workflow,
    schedules: scheduleList.rows.map((s) => ({
      cron: s.cron,
      timezone: s.timezone,
      paused: s.paused,
    })),
    inboundHooks: hooks
      .filter((h) => h.workflow_id === workflow.id && h.active)
      .map((h) => ({ slug: h.slug })),
    publicBaseUrl: resolvePublicBaseUrl(),
  });
}

export function connectorPersistEnvelopeFields(connector: {
  id: string;
  slug: string;
  display_name: string;
  driver: string;
  environment: string;
}): Record<string, unknown> {
  const usage = buildConnectorUsage(connector);
  return {
    connector,
    usage,
    next_best_actions: ["author_workflow", "list_workflows", "list_connectors"],
    next_prompt: usage.follow_up,
  };
}

export function buildConnectorUsage(connector: {
  id: string;
  slug: string;
  display_name: string;
  driver: string;
  environment: string;
}): ResourceUsage {
  return {
    kind: "connector",
    slug: connector.slug,
    name: connector.display_name,
    summary: `${connector.driver} connector (${connector.environment})`,
    inputs: [],
    output: null,
    access: [
      {
        via: "cli",
        label: "sk CLI",
        command: `sk connectors get ${connector.id}`,
        detail: `probe health with: sk connectors probe ${connector.id}`,
      },
      {
        via: "chat",
        label: "Workflows",
        detail: `request steps reference it as connector: "${connector.slug}"`,
      },
    ],
    follow_up: "What should this connector do? I can start a workflow draft from a goal.",
  };
}

export function buildKnowledgeSourceUsage(view: {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  scope: string;
  chunk_count: number;
  workflow_id?: string | null;
}): ResourceUsage {
  const scopeDetail =
    view.scope === "workflow"
      ? `scoped to workflow ${view.workflow_id ?? "(bound workflow)"} — only that workflow's authoring context sees it`
      : "tenant-wide — available to every conversation and workflow authoring session";
  return {
    kind: "knowledge_source",
    slug: view.slug,
    name: view.name,
    summary: view.description,
    inputs: [],
    output: `${view.chunk_count} searchable chunk${view.chunk_count === 1 ? "" : "s"}`,
    access: [
      {
        via: "chat",
        label: "Chat / authoring",
        command: `search_knowledge("<query>")`,
        detail: scopeDetail,
      },
      {
        via: "cli",
        label: "sk CLI",
        command: `sk knowledge-sources search "<query>"`,
      },
    ],
    follow_up: "Try a search against it?",
  };
}
