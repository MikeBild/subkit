import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Executor } from "../db/client.ts";
import {
  connectors,
  conversationElicitations,
  conversations,
  conversationToolCalls,
  executions,
  fileLinks,
  files,
  intakeItems,
  knowledgeSources,
  workflows,
} from "../db/schema/index.ts";
import { executionVisibilityFilter } from "../execution/execution-owner.ts";
import { loadExecutionOutcome } from "../execution/outcome.ts";
import { can } from "../rbac/evaluator.ts";
import {
  type PlaybookDocument,
  PlaybookDocumentSchema,
  type PlaybookResource,
  type PlaybookStep,
} from "./playbook-contract.ts";
import type { PlaybookEvidenceResolution } from "./playbook-state.ts";
import { canonicalJson } from "./text-line-diff.ts";
import { interpretConfirmDecision } from "./tools/ask-user/interpret-confirm.ts";

export interface PlaybookScope {
  tenant_id: string;
  conversation_id: string;
  principal: ResolvedPrincipal;
  locale?: "de" | "en";
}
export interface ResolvedPlaybookEvidence extends PlaybookEvidenceResolution {
  fingerprint: string | null;
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export function playbookFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
export function playbookEvidenceKey(step: PlaybookStep, evidenceId: string): string {
  return `${step.id}:${evidenceId}`;
}
function criterionBinding(document: PlaybookDocument, step: PlaybookStep): unknown {
  return {
    goal: document.plan.goal,
    criterion: step.criterion,
    dependencies: step.depends_on.map((id) => {
      const dependency = document.plan.steps.find((item) => item.id === id);
      return dependency
        ? {
            id,
            criterion: dependency.criterion,
            evidence: dependency.evidence_ids.map(
              (evidenceId) =>
                document.evidence_fingerprints[playbookEvidenceKey(dependency, evidenceId)] ?? null,
            ),
          }
        : { id };
    }),
  };
}

function draftBinding(draftValue: unknown): unknown {
  const draft = object(draftValue);
  const connector = object(draft.connector);
  return {
    workflow: draft.workflow ?? null,
    connector: {
      config: connector.config ?? null,
      base_url: connector.base_url ?? null,
      driver: connector.driver ?? null,
      auth_type: connector.auth_type ?? null,
      environment: connector.environment ?? null,
    },
  };
}

export function humanConfirmationContextFingerprint(
  rawDocument: unknown,
  question: unknown,
  draft: unknown,
): string | null {
  const parsed = PlaybookDocumentSchema.safeParse(rawDocument);
  if (!parsed.success || typeof question !== "string") return null;
  const steps = parsed.data.plan.steps.filter(
    (step) => step.criterion.kind === "human_confirmation" && step.criterion.question === question,
  );
  const step = steps[0];
  if (steps.length !== 1 || !step) return null;
  return playbookFingerprint({
    step_id: step.id,
    binding: criterionBinding(parsed.data, step),
    draft: draftBinding(draft),
  });
}

async function resourceState(
  db: Executor,
  scope: PlaybookScope,
  resource: PlaybookResource,
): Promise<{ fingerprint: string; updated_at: Date; slug?: string | null } | null> {
  const permission = `${resource.type}:read`;
  const resourceType = resource.type;
  if (
    !(
      await can(db, {
        tenant_id: scope.tenant_id,
        principal: scope.principal,
        permission,
        resource: { type: resourceType, id: resource.id },
        quiet: true,
      })
    ).allow
  )
    return null;
  const tenantId = scope.tenant_id;
  switch (resource.type) {
    case "connector": {
      if (
        scope.principal.allowed_connectors &&
        scope.principal.allowed_connectors !== "all" &&
        !scope.principal.allowed_connectors.includes(resource.id)
      )
        return null;
      const [row] = await db
        .select({
          updated_at: connectors.updated_at,
          environment: connectors.environment,
          id: connectors.id,
        })
        .from(connectors)
        .where(
          and(
            eq(connectors.tenant_id, tenantId),
            eq(connectors.id, resource.id),
            isNull(connectors.deleted_at),
          ),
        )
        .limit(1);
      return row ? { fingerprint: playbookFingerprint(row), updated_at: row.updated_at } : null;
    }
    case "workflow": {
      if (
        scope.principal.allowed_workflows &&
        scope.principal.allowed_workflows !== "all" &&
        !scope.principal.allowed_workflows.includes(resource.id)
      )
        return null;
      const [row] = await db
        .select({
          updated_at: workflows.updated_at,
          current_version_id: workflows.current_version_id,
          draft_version_id: workflows.draft_version_id,
          lifecycle: workflows.lifecycle,
        })
        .from(workflows)
        .where(
          and(
            eq(workflows.tenant_id, tenantId),
            eq(workflows.id, resource.id),
            isNull(workflows.deleted_at),
          ),
        )
        .limit(1);
      return row ? { fingerprint: playbookFingerprint(row), updated_at: row.updated_at } : null;
    }
    case "execution": {
      const [row] = await db
        .select({
          status: executions.status,
          created_at: executions.created_at,
          finished_at: executions.finished_at,
          version_id: executions.workflow_version_id,
        })
        .from(executions)
        .where(
          and(
            eq(executions.tenant_id, tenantId),
            eq(executions.id, resource.id),
            executionVisibilityFilter(scope.principal),
          ),
        )
        .limit(1);
      return row
        ? { fingerprint: playbookFingerprint(row), updated_at: row.finished_at ?? row.created_at }
        : null;
    }
    case "knowledge": {
      const [row] = await db
        .select({ updated_at: knowledgeSources.updated_at, status: knowledgeSources.status })
        .from(knowledgeSources)
        .where(
          and(
            eq(knowledgeSources.tenant_id, tenantId),
            eq(knowledgeSources.id, resource.id),
            isNull(knowledgeSources.deleted_at),
          ),
        )
        .limit(1);
      return row ? { fingerprint: playbookFingerprint(row), updated_at: row.updated_at } : null;
    }
    case "intake": {
      const [row] = await db
        .select({
          updated_at: intakeItems.updated_at,
          version: intakeItems.version,
          state: intakeItems.state,
        })
        .from(intakeItems)
        .where(and(eq(intakeItems.tenant_id, tenantId), eq(intakeItems.id, resource.id)))
        .limit(1);
      return row ? { fingerprint: playbookFingerprint(row), updated_at: row.updated_at } : null;
    }
    case "file": {
      const [row] = await db
        .select({
          updated_at: files.updated_at,
          sha256: files.sha256,
          status: files.status,
          replaced_at: files.replaced_at,
          slug: fileLinks.slug,
        })
        .from(files)
        .innerJoin(
          fileLinks,
          and(
            eq(fileLinks.file_id, files.id),
            eq(fileLinks.tenant_id, tenantId),
            eq(fileLinks.resource_type, "conversation"),
            eq(fileLinks.resource_id, scope.conversation_id),
          ),
        )
        .where(
          and(eq(files.tenant_id, tenantId), eq(files.id, resource.id), isNull(files.deleted_at)),
        )
        .limit(1);
      return row && row.status === "ready" && !row.replaced_at
        ? { fingerprint: playbookFingerprint(row), updated_at: row.updated_at, slug: row.slug }
        : null;
    }
  }
}

const resourceTool: Record<PlaybookResource["type"], string> = {
  connector: "get_connector",
  workflow: "get_workflow",
  execution: "get_execution",
  knowledge: "read_knowledge",
  file: "preview_attachment",
  intake: "get_intake_item",
};
const resourceOutput: Record<PlaybookResource["type"], string> = {
  connector: "connector",
  workflow: "workflow",
  execution: "execution",
  knowledge: "source",
  file: "",
  intake: "item",
};
const resourcePath: Record<PlaybookResource["type"], string> = {
  connector: "connectors",
  workflow: "workflows",
  execution: "executions",
  knowledge: "knowledge",
  file: "files",
  intake: "intake",
};

export async function resolvePlaybookEvidence(
  db: Executor,
  scope: PlaybookScope,
  document: PlaybookDocument,
  step: PlaybookStep,
  evidenceId: string,
): Promise<ResolvedPlaybookEvidence> {
  const missing: ResolvedPlaybookEvidence = {
    matches: false,
    fingerprint: null,
    reason:
      scope.locale === "en"
        ? "The evidence is unavailable or unsuitable for this check."
        : "Der Beleg ist nicht verfügbar oder für diese Prüfung nicht geeignet.",
    evidence: {
      id: evidenceId,
      kind: "tool_call",
      label: scope.locale === "en" ? "Evidence unavailable" : "Beleg nicht verfügbar",
      resource_type: null,
      resource_id: null,
      observed_at: null,
      freshness: "unavailable",
      href: null,
    },
  };
  if (scope.principal.tenant_id !== scope.tenant_id || step.criterion.kind === "assessment")
    return missing;
  const [call] = await db
    .select()
    .from(conversationToolCalls)
    .where(
      and(
        eq(conversationToolCalls.tenant_id, scope.tenant_id),
        eq(conversationToolCalls.conversation_id, scope.conversation_id),
        eq(conversationToolCalls.id, evidenceId),
      ),
    )
    .limit(1);
  if (step.criterion.kind === "human_confirmation") {
    const [decision] = await db
      .select()
      .from(conversationElicitations)
      .where(
        and(
          eq(conversationElicitations.tenant_id, scope.tenant_id),
          eq(conversationElicitations.conversation_id, scope.conversation_id),
          eq(conversationElicitations.id, evidenceId),
        ),
      )
      .limit(1);
    if (
      decision?.tool_name !== "ask_user_confirm" ||
      decision.decided_by_kind !== "user" ||
      !decision.decided_by ||
      decision.status !== "resolved" ||
      interpretConfirmDecision(decision.output) !== "confirmed" ||
      object(decision.input).question !== step.criterion.question ||
      object(decision.input).commit_intent
    )
      return missing;
    if (
      !(
        await can(db, {
          tenant_id: scope.tenant_id,
          principal: scope.principal,
          permission: "conversation:read",
          resource: { type: "conversation", id: scope.conversation_id },
          quiet: true,
        })
      ).allow
    )
      return missing;
    const [conversation] = await db
      .select({ draft: conversations.draft, playbook: conversations.playbook })
      .from(conversations)
      .where(
        and(
          eq(conversations.tenant_id, scope.tenant_id),
          eq(conversations.id, scope.conversation_id),
        ),
      )
      .limit(1);
    const currentContext = humanConfirmationContextFingerprint(
      conversation?.playbook,
      step.criterion.question,
      conversation?.draft,
    );
    const fresh =
      decision.decided_at !== null &&
      decision.decided_at.getTime() <= decision.expires_at.getTime();
    const contextMatches =
      currentContext !== null && decision.playbook_context_fingerprint === currentContext;
    return {
      matches: fresh && contextMatches,
      fingerprint: playbookFingerprint({
        binding: criterionBinding(document, step),
        draft: draftBinding(conversation?.draft),
        decision: decision.id,
        decided_at: decision.decided_at,
      }),
      reason: !contextMatches
        ? scope.locale === "en"
          ? "The confirmed question no longer matches the playbook and draft shown when it was asked."
          : "Die bestätigte Frage gehört nicht mehr exakt zum Playbook- und Entwurfsstand beim Antworten."
        : scope.locale === "en"
          ? "An authenticated person confirmed this specific question. This does not grant additional permission to make changes."
          : "Die konkrete Frage wurde von einer authentifizierten Person bestätigt. Dies ist keine zusätzliche Wirkungserlaubnis.",
      evidence: {
        id: evidenceId,
        kind: "decision",
        label: scope.locale === "en" ? "Human confirmation" : "Menschliche Bestätigung",
        resource_type: "conversation",
        resource_id: scope.conversation_id,
        observed_at: decision.decided_at?.toISOString() ?? null,
        freshness: fresh && contextMatches ? "fresh" : "stale",
        href: null,
      },
    };
  }
  if (call?.outcome !== "ok") return missing;
  const output = object(call.output);
  if (step.criterion.kind === "resource_observed") {
    const resource = step.criterion.resource;
    const matchingTool =
      resource.type === "execution"
        ? call.tool === "get_execution" || call.tool === "inspect_execution"
        : call.tool === resourceTool[resource.type];
    if (!matchingTool) return missing;
    const current = await resourceState(db, scope, resource);
    if (!current) return missing;
    const matched =
      resource.type === "file"
        ? object(call.input).slug === current.slug &&
          typeof output.content === "string" &&
          output._truncated === false
        : resource.type === "execution" && call.tool === "inspect_execution"
          ? object(output.inspected).execution_id === resource.id &&
            object(output.execution).execution_id === resource.id
          : object(output[resourceOutput[resource.type]]).id === resource.id;
    if (
      !matched ||
      (resource.type === "knowledge" &&
        (output.has_more === true ||
          typeof output.next_offset === "number" ||
          (object(call.input).offset !== undefined && object(call.input).offset !== 0) ||
          object(call.input).path !== undefined))
    )
      return missing;
    const fresh = current.updated_at.getTime() <= call.created_at.getTime();
    return {
      matches: fresh,
      fingerprint: playbookFingerprint({
        binding: criterionBinding(document, step),
        resource: current.fingerprint,
        call: call.id,
      }),
      reason:
        scope.locale === "en"
          ? "The referenced resource was read. Subject-matter conclusions require a separate check."
          : "Die angegebene Ressource wurde gelesen. Fachliche Schlussfolgerungen benötigen eine eigene Prüfung.",
      evidence: {
        id: evidenceId,
        kind: "tool_call",
        label:
          scope.locale === "en"
            ? resource.type === "execution"
              ? "Execution read"
              : "Resource read"
            : resource.type === "execution"
              ? "Ausführung gelesen"
              : "Ressource gelesen",
        resource_type: resource.type,
        resource_id: resource.id,
        observed_at: call.created_at.toISOString(),
        freshness: fresh ? "fresh" : "stale",
        href:
          resource.type === "execution"
            ? `/cockpit/?run=${resource.id}`
            : resource.type === "intake"
              ? `/cockpit/intake?item=${encodeURIComponent(resource.id)}`
              : `/cockpit/${resourcePath[resource.type]}/${resource.id}`,
      },
    };
  }
  if (call.tool !== "get_execution") return missing;
  const executionId = object(output.execution).id;
  if (typeof executionId !== "string") return missing;
  const current = await resourceState(db, scope, { type: "execution", id: executionId });
  const workflow = await resourceState(db, scope, {
    type: "workflow",
    id: step.criterion.workflow_id,
  });
  if (!current || !workflow) return missing;
  const [run] = await db
    .select({
      id: executions.id,
      workflow_version_id: executions.workflow_version_id,
      source_kind: executions.source_kind,
      status: executions.status,
      workflow_id: executions.workflow_id,
      version_id: executions.workflow_version_id,
      mode: executions.execution_mode,
      started_at: executions.started_at,
      finished_at: executions.finished_at,
      hold_writes: executions.hold_writes,
      output_contract: executions.output_contract,
      failure: executions.failure,
      current_version: workflows.current_version_id,
    })
    .from(executions)
    .innerJoin(
      workflows,
      and(eq(workflows.tenant_id, scope.tenant_id), eq(workflows.id, executions.workflow_id)),
    )
    .where(
      and(
        eq(executions.tenant_id, scope.tenant_id),
        eq(executions.id, executionId),
        executionVisibilityFilter(scope.principal),
      ),
    )
    .limit(1);
  if (!run || run.workflow_id !== step.criterion.workflow_id) return missing;
  const outcome = await loadExecutionOutcome(scope.tenant_id, run, db);
  const fresh =
    outcome.kind === "succeeded" &&
    outcome.output_contract !== "violated" &&
    outcome.steps.failed === 0 &&
    outcome.steps.held === 0 &&
    run.status === "succeeded" &&
    run.source_kind === "saved" &&
    run.version_id !== null &&
    run.version_id === run.current_version &&
    run.mode === step.criterion.environment &&
    run.started_at !== null &&
    run.started_at.getTime() >=
      Math.max(Date.parse(step.criterion.after), Date.parse(document.created_at)) &&
    object(output.execution).status === "succeeded" &&
    object(output.outcome).kind === "succeeded" &&
    run.finished_at !== null &&
    call.created_at.getTime() >= run.finished_at.getTime() &&
    !run.hold_writes &&
    !run.failure;
  return {
    matches: fresh,
    fingerprint: playbookFingerprint({
      binding: criterionBinding(document, step),
      execution: current.fingerprint,
      outcome,
      workflow: workflow.fingerprint,
    }),
    reason: fresh
      ? scope.locale === "en"
        ? "A new successful run of the current workflow version in the required environment is evidenced."
        : "Ein neuer erfolgreicher Lauf der aktuellen Workflow-Version in der verlangten Umgebung ist belegt."
      : scope.locale === "en"
        ? "The run does not yet meet the required version, environment, time, or success criteria."
        : "Der Lauf erfüllt die verlangte Version, Umgebung, Zeit oder den Erfolg noch nicht.",
    evidence: {
      id: evidenceId,
      kind: "execution",
      label: scope.locale === "en" ? "Execution checked" : "Ausführung geprüft",
      resource_type: "execution",
      resource_id: executionId,
      observed_at: call.created_at.toISOString(),
      freshness: fresh ? "fresh" : "stale",
      href: `/cockpit/?run=${executionId}`,
    },
  };
}
