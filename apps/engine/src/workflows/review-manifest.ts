import { and, eq, inArray, isNull } from "drizzle-orm";
import { connectorSystemKey, loadConnectorSystems } from "../connectors/system.ts";
import type { Executor } from "../db/client.ts";
import { workflows } from "../db/schema/index.ts";
import { workflowJsonDigest } from "./canonical-json.ts";
import type { WorkflowEffectManifest } from "./effect-manifest.ts";
import { previewWorkflowAuthority } from "./execution-authorities.ts";
import { loadWorkflowReadFacts, type WorkflowReadFacts } from "./read-facts.ts";
import { WorkflowDefSchema } from "./types.ts";

const candidateWorkflowId = "00000000-0000-4000-8000-000000000001";
const candidateVersionId = "00000000-0000-4000-8000-000000000002";

type FactWorkflow = NonNullable<ReturnType<WorkflowReadFacts["workflows"]["get"]>>;
type FactVersion = NonNullable<ReturnType<WorkflowReadFacts["versions"]["get"]>>;

interface WorkflowReviewEffect {
  step_id: string;
  connector_name: string | null;
  connector_slug: string | null;
  effect: "read" | "write" | "unknown";
  target: string | null;
  details?: string[];
}

interface WorkflowReviewManifest {
  digest: string;
  manifest: WorkflowEffectManifest;
  effects: WorkflowReviewEffect[];
  affected_triggers: Array<{
    kind: "schedule" | "webhook";
    name: string;
    cron?: string;
    timezone?: string;
  }>;
  eligible_for_repeated_runs: boolean;
}

function displayTarget(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!url.protocol.startsWith("http") || url.username || url.password) return null;
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

function candidateHistory(
  facts: WorkflowReadFacts,
  workflow_id: string,
  version_id: string,
  steps: string[],
) {
  return {
    ...facts.history,
    workflow_ids: new Set([...facts.history.workflow_ids, workflow_id]),
    version_ids: new Set([...facts.history.version_ids, version_id]),
    step_ids: new Map([...facts.history.step_ids, [workflow_id, new Set(steps)]]),
  };
}

export function workflowReviewBoundaryDigest(manifest: WorkflowEffectManifest): string {
  return workflowJsonDigest({
    execution_environment: manifest.execution_environment,
    workflow_digest: manifest.workflow_digest,
    execution_options_digest: manifest.execution_options_digest,
    effects: manifest.effects.map(({ tenant_id: _tenant_id, ...effect }) => effect),
    issues: manifest.issues,
    calls: manifest.calls?.map(
      ({ workflow_id: _workflow_id, workflow_version_id: _workflow_version_id, ...call }) => call,
    ),
    caller_guards: manifest.caller_guards,
  });
}

export async function resolveWorkflowReviewManifest(
  input: {
    tenant_id: string;
    workflow_id?: string | null;
    definition: unknown;
    environment: "dev" | "prod";
  },
  db: Executor,
  options: { facts?: WorkflowReadFacts } = {},
): Promise<WorkflowReviewManifest> {
  const definition = WorkflowDefSchema.parse(input.definition);
  const workflow_id = input.workflow_id ?? candidateWorkflowId;
  const version_id = candidateVersionId;
  const callIds = definition.steps.flatMap((step) =>
    step.kind === "call" && step.workflow_id ? [step.workflow_id] : [],
  );
  const callSlugs = definition.steps.flatMap((step) =>
    step.kind === "call" && step.workflow_slug ? [step.workflow_slug] : [],
  );
  const calledBySlug = callSlugs.length
    ? await db
        .select({ id: workflows.id })
        .from(workflows)
        .where(
          and(
            eq(workflows.tenant_id, input.tenant_id),
            inArray(workflows.slug, callSlugs),
            eq(workflows.lifecycle, "active"),
            isNull(workflows.deleted_at),
          ),
        )
    : [];
  const factIds = [
    ...new Set([
      ...(input.workflow_id ? [input.workflow_id] : []),
      ...callIds,
      ...calledBySlug.map((row) => row.id),
    ]),
  ];
  const loaded = options.facts ?? (await loadWorkflowReadFacts(db, input.tenant_id, factIds, []));
  if (loaded.tenant_id !== input.tenant_id) throw new Error("workflow facts tenant mismatch");
  const connectorIds = definition.steps.flatMap((step) =>
    step.kind === "request" && step.connector_id ? [step.connector_id] : [],
  );
  const systems = await loadConnectorSystems(
    input.tenant_id,
    [...new Set(connectorIds)].map((connector_id) => ({
      connector_id,
      environment: input.environment,
    })),
    db,
  );
  const facts: WorkflowReadFacts = {
    ...loaded,
    workflows: new Map([
      ...loaded.workflows,
      [
        workflow_id,
        {
          id: workflow_id,
          tenant_id: input.tenant_id,
          lifecycle: "draft",
          current_version_id: version_id,
          draft_version_id: version_id,
          slug: definition.slug ?? "workflow-review-candidate",
          name: definition.name,
        } as FactWorkflow,
      ],
    ]),
    versions: new Map([
      ...loaded.versions,
      [
        version_id,
        {
          id: version_id,
          workflow_id,
          tenant_id: input.tenant_id,
          dag: definition,
          version: 0,
        } as FactVersion,
      ],
    ]),
    connectors: new Map([...loaded.connectors, ...systems]),
    history: candidateHistory(
      loaded,
      workflow_id,
      version_id,
      definition.steps.map((step) => step.id),
    ),
  };
  const resolved = await previewWorkflowAuthority(
    {
      tenant_id: input.tenant_id,
      workflow_id,
      workflow_version_id: version_id,
      execution_environment: input.environment,
    },
    db,
    { facts, report_boundaries: {}, content_boundaries: {} },
  );
  const effects = resolved.manifest.effects.map((effect) => {
    const connector = effect.connector_id
      ? facts.connectors.get(connectorSystemKey(effect.connector_id, effect.environment))?.connector
      : null;
    const details = [
      effect.operation,
      ...(effect.report_delivery ? [`From: ${effect.report_delivery.from}`] : []),
      ...(effect.transactional_delivery
        ? [`Recipient input: ${effect.transactional_delivery.recipient_input}`]
        : []),
      ...(effect.content_publication?.kind === "content_release"
        ? [`Site: ${effect.content_publication.site_id}`]
        : []),
      ...(effect.boundary
        ? [
            `At most ${effect.boundary.max_calls} calls; ${effect.boundary.max_body_bytes} body bytes`,
            ...(Object.keys(effect.boundary.variables).length
              ? [`Variable paths: ${Object.keys(effect.boundary.variables).sort().join(", ")}`]
              : []),
          ]
        : []),
      ...(effect.mcp
        ? [
            `Effect ${effect.mcp.effect} as stated on the step; the tool's description is compared with the server only when you approve`,
            `At most ${effect.mcp.max_calls} calls`,
            ...(effect.mcp.arguments.length
              ? [
                  `Argument variables: ${effect.mcp.arguments
                    .map((entry) => `${entry.path.join(".")} (${entry.var})`)
                    .join(", ")}`,
                ]
              : []),
          ]
        : []),
    ];
    return {
      step_id: effect.step_id,
      connector_name: connector?.display_name ?? null,
      connector_slug: connector?.slug ?? null,
      effect: (effect.effect === "read"
        ? "read"
        : effect.effect === "unknown"
          ? "unknown"
          : "write") as WorkflowReviewEffect["effect"],
      target: effect.mcp
        ? `${effect.mcp.server}#${effect.mcp.tool}`
        : (effect.report_delivery?.to ?? displayTarget(effect.target)),
      ...(details.length ? { details } : {}),
    };
  });
  const trigger = definition.trigger;
  const affected_triggers =
    trigger?.kind === "schedule"
      ? [
          {
            kind: "schedule" as const,
            name: "Workflow schedule",
            cron: trigger.cron,
            timezone: trigger.tz,
          },
        ]
      : trigger?.kind === "webhook"
        ? [{ kind: "webhook" as const, name: trigger.source }]
        : [];
  return {
    digest: workflowReviewBoundaryDigest(resolved.manifest),
    manifest: resolved.manifest,
    effects,
    affected_triggers,
    eligible_for_repeated_runs: resolved.eligible_for_repeated_runs,
  };
}
