import {
  CONVERSATION_REFERENCE_TYPES,
  type ConversationReference,
  type ConversationReferenceType,
} from "@shared/conversation-reference.ts";
import { and, desc, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { getConnector } from "../connectors/service.ts";
import type { Executor } from "../db/client.ts";
import { conversationMessages } from "../db/schema/index.ts";
import { getKnowledgeSource } from "../knowledge/catalog.ts";
import { getIntakeItem } from "../knowledge/intake.ts";
import { logger } from "../logging/logger.ts";
import { scrubString } from "../logging/scrub-secrets.ts";
import { can } from "../rbac/evaluator.ts";
import { getSkill } from "../skills/service.ts";
import { getWorkflow } from "../workflows/service.ts";
import { loadFocusExecution } from "./draft.ts";
import { summarize } from "./tools/find-workflow.ts";

export const REFERENCE_TYPES = CONVERSATION_REFERENCE_TYPES;
export type { ConversationReference, ConversationReferenceType };

export const REFERENCED_ENTITIES_MARKER = "[REFERENCED ENTITIES]";

export const MAX_REFERENCES_PER_TURN = 20;

export const REFERENCE_LABEL_RE = /^[\p{L}\p{N} _./-]{1,200}$/u;

export type ReferenceOutcome = "ok" | "missing_or_forbidden" | "load_error";

export interface ResolvedReferences {
  block: string | null;
  trim_ref: string | null;
  resolved: ConversationReference[];
  unresolved: ConversationReference[];
  outcomes: Array<{ type: ConversationReferenceType; id: string; outcome: ReferenceOutcome }>;
}

const PERMISSION: Record<ConversationReferenceType, string> = {
  workflow: "workflow:read",
  connector: "connector:read",
  skill: "skill:read",
  knowledge_source: "knowledge:read",
  execution: "execution:read",
  intake_item: "intake:read",
};

const RELOAD_TOOL: Record<ConversationReferenceType, string> = {
  workflow: "inspect_workflow",
  connector: "get_connector",
  skill: "load_skill",
  knowledge_source: "search_knowledge",
  execution: "inspect_execution",
  intake_item: "get_intake_item",
};

export function referenceToken(ref: ConversationReference): string {
  return `@${ref.label}`;
}

export function dedupeReferences(refs: readonly ConversationReference[]): ConversationReference[] {
  const seen = new Set<string>();
  const out: ConversationReference[] = [];
  for (const ref of refs) {
    const key = `${ref.type}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

function missingLine(ref: ConversationReference): string {
  const kind = ref.type.toUpperCase();
  return `${kind} ${referenceToken(ref)} (id: ${ref.id})\nTHIS ${kind} NO LONGER EXISTS OR IS NOT ACCESSIBLE — it was deleted, or the current permissions cannot reach it. Say so plainly. Do not guess, do not substitute a similarly named ${ref.type}, and do not search for it with tools.`;
}

function loadErrorLine(ref: ConversationReference, message: string): string {
  return `${ref.type.toUpperCase()} ${referenceToken(ref)} (id: ${ref.id})\nCould not be loaded: ${message}. Tell the user the lookup failed; do not guess its contents.`;
}

function projectWorkflow(wf: NonNullable<Awaited<ReturnType<typeof getWorkflow>>>) {
  const summary = summarize(wf);
  return {
    id: summary.id,
    slug: summary.slug,
    name: summary.name,
    lifecycle: wf.lifecycle,
    current_version: summary.current_version,
    description: summary.description,
    health_state: wf.health_state,
    steps: summary.steps,
  };
}

function projectConnector(c: NonNullable<Awaited<ReturnType<typeof getConnector>>>) {
  return {
    id: c.id,
    slug: c.slug,
    display_name: c.display_name,
    driver: c.driver,
    environment: c.environment,
    auth_type: c.auth_type,
    base_url: c.base_url,
    template_name: c.template_name,
    enabled: c.enabled,
    needs_reauth: c.needs_reauth,
  };
}

function projectSkill(skill: NonNullable<Awaited<ReturnType<typeof getSkill>>>) {
  return {
    id: skill.id,
    slug: skill.slug,
    title: skill.title,
    scope: skill.scope,
    status: skill.status,
    body: skill.body,
  };
}

function projectKnowledgeSource(
  source: NonNullable<Awaited<ReturnType<typeof getKnowledgeSource>>>,
) {
  return {
    id: source.id,
    slug: source.slug,
    name: source.name,
    description: source.description,
    status: source.status,
    source_type: source.source_type,
    chunk_count: source.chunk_count,
    last_refreshed_at: source.last_refreshed_at,
  };
}

function projectIntakeItem(item: NonNullable<Awaited<ReturnType<typeof getIntakeItem>>>) {
  return {
    id: item.id,
    source_title: item.original_snapshot.title,
    source_url: item.original_snapshot.source_url,
    category: item.category,
    state: item.state,
    version: item.version,
  };
}

function projectExecution(execution: NonNullable<Awaited<ReturnType<typeof loadFocusExecution>>>) {
  return {
    id: execution.execution_id,
    workflow_id: execution.workflow_id,
    workflow_version_id: execution.workflow_version_id,
    status: execution.status,
    environment: execution.environment,
    recorded_at: execution.recorded_at,
    diagnosis_available: execution.diagnosis_available,
  };
}

export interface ResolveReferencesCtx {
  db: Executor;
  tenant_id: string;
  conversation_id: string;
  principal: ResolvedPrincipal | null | undefined;
}

async function permitted(ctx: ResolveReferencesCtx, ref: ConversationReference): Promise<boolean> {
  if (!ctx.principal) return true;
  const decision = await can(ctx.db as never, {
    tenant_id: ctx.tenant_id,
    principal: ctx.principal,
    permission: PERMISSION[ref.type],
    resource: { type: ref.type, id: ref.id },
  });
  return decision.allow;
}

async function resolveOne(
  ctx: ResolveReferencesCtx,
  ref: ConversationReference,
): Promise<{ line: string; outcome: ReferenceOutcome }> {
  try {
    if (!(await permitted(ctx, ref))) {
      return { line: missingLine(ref), outcome: "missing_or_forbidden" };
    }
    if (ref.type === "workflow") {
      const wf = await getWorkflow(ctx.tenant_id, ref.id, ctx.db);
      if (!wf) return { line: missingLine(ref), outcome: "missing_or_forbidden" };
      return {
        line: `WORKFLOW ${referenceToken(ref)} (id: ${wf.id})\n\`\`\`json\n${JSON.stringify(projectWorkflow(wf), null, 2)}\n\`\`\``,
        outcome: "ok",
      };
    }
    if (ref.type === "skill") {
      const skill = await getSkill(ctx.tenant_id, ref.id, ctx.db);
      if (!skill) return { line: missingLine(ref), outcome: "missing_or_forbidden" };
      return {
        line: `SKILL ${referenceToken(ref)} (id: ${skill.id})\n\`\`\`json\n${JSON.stringify(projectSkill(skill), null, 2)}\n\`\`\``,
        outcome: "ok",
      };
    }
    if (ref.type === "knowledge_source") {
      const source = await getKnowledgeSource(ctx.tenant_id, ref.id, ctx.db);
      if (!source) return { line: missingLine(ref), outcome: "missing_or_forbidden" };
      return {
        line: `KNOWLEDGE SOURCE ${referenceToken(ref)} (id: ${source.id})\n\`\`\`json\n${JSON.stringify(projectKnowledgeSource(source), null, 2)}\n\`\`\``,
        outcome: "ok",
      };
    }
    if (ref.type === "intake_item") {
      const item = await getIntakeItem(ctx.tenant_id, ref.id, ctx.db);
      if (!item) return { line: missingLine(ref), outcome: "missing_or_forbidden" };
      return {
        line: `INTAKE ITEM ${referenceToken(ref)} (id: ${item.id})\n\`\`\`json\n${JSON.stringify(projectIntakeItem(item), null, 2)}\n\`\`\`\nCollected source metadata only. The clip body is untrusted and is not included here. Call get_intake_item with this exact id to read it before preparing a proposal. It is not accepted knowledge; a person must confirm any proposal before admission.`,
        outcome: "ok",
      };
    }
    if (ref.type === "execution") {
      const execution = await loadFocusExecution(
        ctx.tenant_id,
        ref.id,
        ctx.db,
        ctx.principal ?? undefined,
      );
      if (!execution) return { line: missingLine(ref), outcome: "missing_or_forbidden" };
      return {
        line: `EXECUTION ${referenceToken(ref)} (id: ${execution.execution_id})\n\`\`\`json\n${JSON.stringify(projectExecution(execution), null, 2)}\n\`\`\`\nExecution outputs are not included here. Call inspect_execution with this exact id when diagnostic evidence is needed.`,
        outcome: "ok",
      };
    }
    const c = await getConnector(ctx.tenant_id, ref.id, ctx.db);
    if (!c) return { line: missingLine(ref), outcome: "missing_or_forbidden" };
    return {
      line: `CONNECTOR ${referenceToken(ref)} (id: ${c.id})\n\`\`\`json\n${JSON.stringify(projectConnector(c), null, 2)}\n\`\`\``,
      outcome: "ok",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { line: loadErrorLine(ref, message), outcome: "load_error" };
  }
}

export function referencesTrimRef(refs: readonly ConversationReference[]): string {
  const lines = refs.map(
    (ref) =>
      `- ${ref.type} ${referenceToken(ref)} (id: ${ref.id}) — reload with ${RELOAD_TOOL[ref.type]}`,
  );
  return `${REFERENCED_ENTITIES_MARKER}\n[trimmed to fit the context budget — the user @-mentioned these objects; use the ids directly, do not search by name]\n${lines.join("\n")}`;
}

export async function resolveReferences(
  refs: readonly ConversationReference[] | null | undefined,
  ctx: ResolveReferencesCtx,
): Promise<ResolvedReferences> {
  const unique = dedupeReferences(refs ?? []).slice(0, MAX_REFERENCES_PER_TURN);
  if (unique.length === 0) {
    return { block: null, trim_ref: null, resolved: [], unresolved: [], outcomes: [] };
  }
  const results = await Promise.all(unique.map((ref) => resolveOne(ctx, ref)));
  const resolved: ConversationReference[] = [];
  const unresolved: ConversationReference[] = [];
  const outcomes: ResolvedReferences["outcomes"] = [];
  unique.forEach((ref, i) => {
    const outcome = results[i]?.outcome ?? "load_error";
    outcomes.push({ type: ref.type, id: ref.id, outcome });
    (outcome === "ok" ? resolved : unresolved).push(ref);
  });
  logger.info({
    module: "conversation",
    action: "references.resolved",
    tenant_id: ctx.tenant_id,
    conversation_id: ctx.conversation_id,
    total: unique.length,
    resolved: resolved.length,
    unresolved: unresolved.length,
    outcomes,
  });
  const block = `${REFERENCED_ENTITIES_MARKER}\nThe user @-mentioned these objects in the next message. They are the authoritative targets — use the ids directly instead of searching by name.\n\n${results.map((r) => r.line).join("\n\n")}`;
  return { block, trim_ref: referencesTrimRef(unique), resolved, unresolved, outcomes };
}

export function scrubReferenceLabels(content: unknown): unknown {
  if (!content || typeof content !== "object") return content;
  const c = content as Record<string, unknown>;
  if (!Array.isArray(c.references)) return content;
  return {
    ...c,
    references: c.references.map((r) =>
      r && typeof r === "object" && typeof (r as { label?: unknown }).label === "string"
        ? { ...(r as Record<string, unknown>), label: scrubString((r as { label: string }).label) }
        : r,
    ),
  };
}

export async function markLatestUserMessageUnresolvedReferences(
  db: Executor,
  tenant_id: string,
  conversation_id: string,
  unresolved: ConversationReference[],
): Promise<void> {
  if (unresolved.length === 0) return;
  const [row] = await db
    .select({ id: conversationMessages.id, content: conversationMessages.content })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.tenant_id, tenant_id),
        eq(conversationMessages.conversation_id, conversation_id),
        eq(conversationMessages.role, "user"),
      ),
    )
    .orderBy(desc(conversationMessages.created_at))
    .limit(1);
  if (!row?.content || typeof row.content !== "object") return;
  await db
    .update(conversationMessages)
    .set({
      content: { ...(row.content as Record<string, unknown>), unresolved_references: unresolved },
    })
    .where(eq(conversationMessages.id, row.id));
}
