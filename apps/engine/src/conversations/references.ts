// Conversation references — the structured side of an `@`-mention.
//
// A composer that offers `@`-completion sends, next to the prose, the
// objects the person picked: `{ type, id, label }`. The prose keeps a
// readable token (`@customer-sync`); the reference carries the id. The
// model never has to turn a name back into an object, and a name that
// two objects share stops being ambiguous.
//
// Resolution happens on EVERY turn, never from a cache on the message:
// an object deleted (or withdrawn by RBAC) after the message was sent is
// reported as gone instead of served stale. Not-found and not-permitted
// deliberately produce the same sentence — the transcript must not
// distinguish "you may not see this" from "this is gone".
//
// Sibling of `attachments.ts` (`@attachment:<slug>` → file). Both are
// chokepoint-resolved; this one adds RBAC because a workflow or connector
// is a governed resource, a conversation attachment is not.

import { and, desc, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { getConnector } from "../connectors/service.ts";
import type { Executor } from "../db/client.ts";
import { conversationMessages } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";
import { scrubString } from "../logging/scrub-secrets.ts";
import { can } from "../rbac/evaluator.ts";
import { getWorkflow } from "../workflows/service.ts";
import { summarize } from "./tools/find-workflow.ts";

export const REFERENCE_TYPES = ["workflow", "connector"] as const;
export type ConversationReferenceType = (typeof REFERENCE_TYPES)[number];

export interface ConversationReference {
  type: ConversationReferenceType;
  id: string;
  /** What the person saw in the picker — a slug or display name, never an id. */
  label: string;
}

/** Marker that opens the block; the trim reference keeps it so the model
 *  can still tell that references existed on this turn. */
export const REFERENCED_ENTITIES_MARKER = "[REFERENCED ENTITIES]";

/** Bound on references per turn — matches the request schema's `max`. */
export const MAX_REFERENCES_PER_TURN = 20;

/** Slug and display-name characters only. A label is display text the
 *  person picked from a catalogue, so anything outside this set is not
 *  a label. Keeps a pasted secret out of the persisted row by shape. */
export const REFERENCE_LABEL_RE = /^[\p{L}\p{N} _./-]{1,200}$/u;

export type ReferenceOutcome = "ok" | "missing_or_forbidden" | "load_error";

export interface ResolvedReferences {
  /** The rendered block, or null when there was nothing to render. */
  block: string | null;
  /** One-line fallback the budget trimmer swaps in instead of dropping. */
  trim_ref: string | null;
  resolved: ConversationReference[];
  unresolved: ConversationReference[];
  outcomes: Array<{ type: ConversationReferenceType; id: string; outcome: ReferenceOutcome }>;
}

const PERMISSION: Record<ConversationReferenceType, string> = {
  workflow: "workflow:read",
  connector: "connector:read",
};

/** The prose token for a reference, e.g. `@customer-sync`. */
export function referenceToken(ref: ConversationReference): string {
  return `@${ref.label}`;
}

/** Same object mentioned twice resolves once. */
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

/** Narrow projection: enough to reason about the workflow, no step bodies. */
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

/** Connector projection: identity, driver, environment, auth TYPE — never
 *  a credential value. Field names are what `get_connector` also serves. */
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

export interface ResolveReferencesCtx {
  db: Executor;
  tenant_id: string;
  conversation_id: string;
  /** Null for system actors — RBAC then does not apply (trusted work). */
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

/** The one-line-per-reference fallback for the budget trimmer. */
export function referencesTrimRef(refs: readonly ConversationReference[]): string {
  const lines = refs.map(
    (ref) =>
      `- ${ref.type} ${referenceToken(ref)} (id: ${ref.id}) — reload with ${ref.type === "workflow" ? "inspect_workflow" : "get_connector"}`,
  );
  return `${REFERENCED_ENTITIES_MARKER}\n[trimmed to fit the context budget — the user @-mentioned these objects; use the ids directly, do not search by name]\n${lines.join("\n")}`;
}

/**
 * Resolve every reference for this turn and render the context block.
 * Never throws: a failed lookup becomes a load-error line so the model
 * hears about it instead of the turn dying.
 */
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
  // `warn` at most: a missing reference is a routine outcome of someone
  // deleting a workflow, not an engine fault. Deploy's log watch treats
  // `error` as a reason to fail the roll.
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

/**
 * A reference label is display text the person picked, but it is still
 * client-supplied prose on a replayed row — it gets the same scrub as the
 * message text. Called from the single insert chokepoint (`appendMessage`).
 */
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

/**
 * Record which @-mentions of the newest user turn the engine could not
 * resolve. Written after resolution (which needs the acting principal, so
 * it cannot happen at insert time) and read by the transcript to flag the
 * chip. A no-op when everything resolved — the row stays untouched.
 */
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
