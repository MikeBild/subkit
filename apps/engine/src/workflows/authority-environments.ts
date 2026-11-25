import {
  APPROVAL_ENVIRONMENTS,
  type EnvironmentAssessments,
  type EnvironmentBlock,
  type EnvironmentBlockCode,
  type EnvironmentRecommendation,
  recommendEnvironment,
} from "@shared/approval-choice.ts";
import { automationEnvironmentDecision } from "@shared/workflow-automation.ts";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { connectorEnvironmentKey } from "../connectors/service.ts";
import { loadConnectorSystems } from "../connectors/system.ts";
import type { Executor } from "../db/client.ts";
import { withTenantScope } from "../db/index.ts";
import {
  connectors,
  webhooksInbound,
  workflowExecutionAuthorities,
  workflows,
  workflowsSchedules,
  workflowVersions,
} from "../db/schema/index.ts";
import {
  connectorUnavailability,
  type FoundConnectorUnavailability,
} from "../execution/connector-availability.ts";
import { collectWorkflowConnectorReferences } from "../execution/prepared-workflow-references.ts";
import { recordedAuthority } from "./authority-observation.ts";
import { executableDefinition, readStoredDefinition } from "./stored-definition.ts";
import type { WorkflowDef } from "./types.ts";

type ApprovalEnvironment = (typeof APPROVAL_ENVIRONMENTS)[number];

const CONTEXT_AUTHORITY_LIMIT = 20;

const BLOCK_FOR: Record<FoundConnectorUnavailability, EnvironmentBlockCode> = {
  disabled: "connector_switched_off",
  needs_reauth: "connector_needs_sign_in_again",
  credential_unavailable: "connector_without_sign_in",
};

interface ConnectorUse {
  step_id: string | null;
  connector_id: string | null;
  slug: string | null;
  credential: boolean | null;
}

interface CallReference {
  step_id: string;
  workflow_id: string | null;
  workflow_slug: string | null;
  root: string;
}

function callsIn(value: unknown, root: string | null, found: CallReference[] = []) {
  if (Array.isArray(value)) {
    for (const child of value) callsIn(child, root, found);
  } else if (value && typeof value === "object") {
    const shaped = value as Record<string, unknown>;
    if (shaped.kind === "call" && typeof shaped.id === "string") {
      const byId = typeof shaped.workflow_id === "string" && shaped.workflow_id.length > 0;
      const bySlug = typeof shaped.workflow_slug === "string" && shaped.workflow_slug.length > 0;
      if (byId !== bySlug)
        found.push({
          step_id: shaped.id,
          workflow_id: byId ? (shaped.workflow_id as string) : null,
          workflow_slug: bySlug ? (shaped.workflow_slug as string) : null,
          root: root ?? shaped.id,
        });
    }
    for (const child of Object.values(shaped)) callsIn(child, root, found);
  }
  return found;
}

async function connectorReferences(db: Executor, tenant_id: string, definition: WorkflowDef) {
  const references = collectWorkflowConnectorReferences(definition);
  const visited = new Set<string>();
  let pending = callsIn(definition.steps, null);
  while (pending.length > 0) {
    const ids = pending.flatMap((call) => (call.workflow_id ? [call.workflow_id] : []));
    const slugs = pending.flatMap((call) => (call.workflow_slug ? [call.workflow_slug] : []));
    const children = await db
      .select({ id: workflows.id, slug: workflows.slug, dag: workflowVersions.dag })
      .from(workflows)
      .innerJoin(
        workflowVersions,
        and(
          eq(workflowVersions.tenant_id, workflows.tenant_id),
          eq(workflowVersions.workflow_id, workflows.id),
          eq(workflowVersions.id, workflows.current_version_id),
        ),
      )
      .where(
        and(
          eq(workflows.tenant_id, tenant_id),
          eq(workflows.lifecycle, "active"),
          isNull(workflows.deleted_at),
          or(
            ids.length > 0 ? inArray(workflows.id, ids) : undefined,
            slugs.length > 0 ? inArray(workflows.slug, slugs) : undefined,
          ),
        ),
      );
    const next: CallReference[] = [];
    for (const call of pending) {
      const child = children.find((row) =>
        call.workflow_id ? row.id === call.workflow_id : row.slug === call.workflow_slug,
      );
      if (!child || visited.has(child.id)) continue;
      const stored = readStoredDefinition(child.dag);
      if (stored.invalid) continue;
      visited.add(child.id);
      collectWorkflowConnectorReferences(stored.definition, references, call.root);
      next.push(...callsIn(stored.definition.steps, call.root));
    }
    pending = next;
  }
  return references;
}

export async function assessAuthorityEnvironments(
  db: Executor,
  tenant_id: string,
  dag: unknown,
): Promise<EnvironmentAssessments> {
  const definition = executableDefinition(dag);
  const references = await connectorReferences(db, tenant_id, definition);
  if (references.refusals.some((refusal) => refusal.reason === "too_many_references"))
    throw Object.assign(
      new Error("This workflow references more connectors than one run can prepare."),
      { code: "prepared_credential_unavailable" },
    );
  const uses: ConnectorUse[] = [
    ...references.refusals.map((refusal) => ({
      step_id: refusal.step_id,
      connector_id: null,
      slug: null,
      credential: null,
    })),
    ...[...references.ids]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([connector_id, step_id]) => ({ step_id, connector_id, slug: null, credential: null })),
    ...[...references.slugs]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([slug, reference]) => ({
        step_id: reference.step_id,
        connector_id: null,
        slug,
        credential: reference.credential,
      })),
  ];
  const slugs = [...references.slugs.keys()];
  const slugRows =
    slugs.length === 0
      ? []
      : await db
          .select({
            id: connectors.id,
            slug: connectors.slug,
            environment: connectors.environment,
            display_name: connectors.display_name,
          })
          .from(connectors)
          .where(
            and(
              eq(connectors.tenant_id, tenant_id),
              inArray(connectors.slug, slugs),
              isNull(connectors.deleted_at),
            ),
          );
  const slugRow = (slug: string, environment: ApprovalEnvironment) =>
    slugRows.find((row) => row.slug === slug && row.environment === environment);
  const idUses = [...references.ids.keys()];
  const systems = await loadConnectorSystems(
    tenant_id,
    [
      ...APPROVAL_ENVIRONMENTS.flatMap((environment) =>
        idUses.map((connector_id) => ({ connector_id, environment })),
      ),
      ...slugRows.map((row) => ({ connector_id: row.id, environment: row.environment })),
    ],
    db,
  );
  const named = (connector_id: string) => {
    const rows = APPROVAL_ENVIRONMENTS.flatMap((environment) => {
      const connector = systems.get(connectorEnvironmentKey(connector_id, environment))?.connector;
      return connector ? [connector] : [];
    });
    return (rows.find((row) => row.id === connector_id) ?? rows[0])?.display_name ?? null;
  };
  const assessed = {} as EnvironmentAssessments;
  for (const environment of APPROVAL_ENVIRONMENTS) {
    const reasons: EnvironmentBlock[] = [];
    const push = (reason: EnvironmentBlock) => {
      const same = (other: EnvironmentBlock) =>
        other.code === reason.code &&
        other.step_id === reason.step_id &&
        other.connector_id === reason.connector_id &&
        other.connector_name === reason.connector_name;
      if (!reasons.some(same)) reasons.push(reason);
    };
    for (const use of uses) {
      const step_id = use.step_id ?? "";
      if (use.slug === null && use.connector_id === null) {
        push({ code: "connector_missing", step_id, connector_id: null, connector_name: null });
        continue;
      }
      const row = use.slug === null ? undefined : slugRow(use.slug, environment);
      const lookup = use.connector_id ?? row?.id;
      const system = lookup ? systems.get(connectorEnvironmentKey(lookup, environment)) : undefined;
      if (!system || system.environment !== environment) {
        const other = APPROVAL_ENVIRONMENTS.flatMap((candidate) => {
          const found = use.slug === null ? undefined : slugRow(use.slug, candidate);
          return found ? [found.display_name] : [];
        })[0];
        push({
          code: "connector_missing",
          step_id,
          connector_id: use.connector_id,
          connector_name: use.connector_id ? named(use.connector_id) : (other ?? use.slug),
        });
        continue;
      }
      const required = use.credential ?? system.connector.auth_type !== "none";
      const unavailability = connectorUnavailability(
        system.connector,
        required ? await system.getAuthorityMetadata() : null,
        required,
      );
      if (unavailability)
        push({
          code: BLOCK_FOR[unavailability],
          step_id,
          connector_id: system.connector.id,
          connector_name: system.connector.display_name,
        });
    }
    assessed[environment] = { possible: reasons.length === 0, reasons };
  }
  return assessed;
}

export async function recommendAuthorityEnvironment(
  db: Executor,
  tenant_id: string,
  workflow_id: string,
  environments: EnvironmentAssessments,
  now: Date,
): Promise<EnvironmentRecommendation> {
  const [workflow] = await db
    .select({ lifecycle: workflows.lifecycle, current_version_id: workflows.current_version_id })
    .from(workflows)
    .where(
      and(
        eq(workflows.tenant_id, tenant_id),
        eq(workflows.id, workflow_id),
        isNull(workflows.deleted_at),
      ),
    )
    .limit(1);
  const hooks = await withTenantScope(db, tenant_id, (tx) =>
    tx
      .select({ id: webhooksInbound.id })
      .from(webhooksInbound)
      .where(
        and(
          eq(webhooksInbound.tenant_id, tenant_id),
          eq(webhooksInbound.workflow_id, workflow_id),
          eq(webhooksInbound.active, true),
        ),
      ),
  );
  const [schedules, authorityRows] = await Promise.all([
    db
      .select({
        id: workflowsSchedules.id,
        cron: workflowsSchedules.cron,
        timezone: workflowsSchedules.timezone,
        execution_mode: workflowsSchedules.execution_mode,
        paused: workflowsSchedules.paused,
      })
      .from(workflowsSchedules)
      .where(
        and(
          eq(workflowsSchedules.tenant_id, tenant_id),
          eq(workflowsSchedules.workflow_id, workflow_id),
        ),
      ),
    db
      .select()
      .from(workflowExecutionAuthorities)
      .where(
        and(
          eq(workflowExecutionAuthorities.tenant_id, tenant_id),
          eq(workflowExecutionAuthorities.workflow_id, workflow_id),
        ),
      )
      .orderBy(desc(workflowExecutionAuthorities.created_at), desc(workflowExecutionAuthorities.id))
      .limit(CONTEXT_AUTHORITY_LIMIT),
  ]);
  const context = automationEnvironmentDecision({
    workflow: { webhooks_active: hooks.length },
    schedules,
    status: null,
    authorities: authorityRows.map((row) => recordedAuthority(row, workflow, now)),
    now: now.getTime(),
  });
  return recommendEnvironment(context, environments);
}

export async function assessVersionEnvironments(
  db: Executor,
  input: { tenant_id: string; workflow_id: string; workflow_version_id: string },
): Promise<EnvironmentAssessments> {
  const [version] = await db
    .select({ dag: workflowVersions.dag })
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.tenant_id, input.tenant_id),
        eq(workflowVersions.workflow_id, input.workflow_id),
        eq(workflowVersions.id, input.workflow_version_id),
      ),
    )
    .limit(1);
  if (!version)
    throw Object.assign(new Error("workflow version unavailable"), {
      code: "workflow_version_unavailable",
    });
  return assessAuthorityEnvironments(db, input.tenant_id, version.dag);
}

export async function reviewAuthorityEnvironments(
  db: Executor,
  input: { tenant_id: string; workflow_id: string; workflow_version_id: string },
  now: Date,
): Promise<{
  environments: EnvironmentAssessments;
  recommended_environment: EnvironmentRecommendation;
}> {
  const environments = await assessVersionEnvironments(db, input);
  return {
    environments,
    recommended_environment: await recommendAuthorityEnvironment(
      db,
      input.tenant_id,
      input.workflow_id,
      environments,
      now,
    ),
  };
}

const ENVIRONMENT_LABEL = { dev: "Test", prod: "Production" } as const;

const BLOCK_PHRASE: Record<EnvironmentBlockCode, string> = {
  connector_missing: "does not exist",
  connector_without_sign_in: "has no sign-in",
  connector_needs_sign_in_again: "must be signed in again",
  connector_switched_off: "is switched off",
};

function blockPhrases(environments: EnvironmentAssessments, environment: "dev" | "prod") {
  return [
    ...new Set(
      environments[environment].reasons.map(
        (block) =>
          `${block.connector_name ?? "a connector"} ${BLOCK_PHRASE[block.code]} in ${ENVIRONMENT_LABEL[environment]}`,
      ),
    ),
  ];
}

export function describeAuthorityEnvironments(environments: EnvironmentAssessments): string | null {
  const possible = APPROVAL_ENVIRONMENTS.filter(
    (environment) => environments[environment].possible,
  );
  if (possible.length === 2) return null;
  const [only] = possible;
  if (only) {
    const blocked = only === "dev" ? "prod" : "dev";
    return `Possible only in ${ENVIRONMENT_LABEL[only]}: ${blockPhrases(environments, blocked).join("; ")}.`;
  }
  return `Not possible in Test or Production yet: ${[
    ...blockPhrases(environments, "dev"),
    ...blockPhrases(environments, "prod"),
  ].join("; ")}.`;
}
