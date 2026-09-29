// Engine fast-path matcher. Skips the LLM turn entirely for a
// whitelisted set of deterministic intents that the LLM would
// otherwise round-trip through 3–5 tool calls just to answer.
//
// Whitelist v1:
//   - `list workflows | connectors | executions | schedules |
//      knowledge sources` (en + de) → render from tenant rows
//   - one catalog block (`zeig mir die <kat>-Workflows`, `workflows in
//     @kategorie/<kat>`, en + de) → every member with what it does,
//     only when `<kat>` is a live derived category
//   - `run <slug>` / `starte <slug>` / `führe <slug> aus` /
//     `execute <slug>` → resolve slug → confirmation gate → execute
//   - `inspect execution <uuid>` → fetch row + steps
//
// Discipline:
//   - Bilingual regex only. No fuzzy matching, no Levenshtein,
//     no keyword regex translations. A miss falls through to the
//     existing LLM-mediated turn.
//   - Same audit + RBAC + confirmation gate the LLM tools use. The
//     `run <slug>` branch routes through `gateWorkflowRunRbac`
//     (the canonical helper extracted from `mcp/capabilities/tools.ts`)
//     and the ONE confirm gate (`tools/policy.ts` + `tools/approval.ts`),
//     so the RBAC decision + APPROVAL_* audit rows match MCP exactly —
//     no "known slug" exemption. The list-side renderers gate on the same
//     `*:read` permissions the HTTP routes enforce.

import { and, asc, desc, eq } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { conversationToolCalls, executionSteps, executions } from "../db/schema/index.ts";
import { runExecution } from "../execution/engine.ts";
import { HELD_PREVIEW_WARNING_CODE } from "../execution/types.ts";
import { admitWorkflowRun } from "../execution/workflow-run-admission.ts";
import { logger } from "../logging/logger.ts";
import { recordConversationToolCall } from "../observability/instrumentation.ts";
import { can } from "../rbac/evaluator.ts";
import {
  approvalAuditResource,
  consumeApproval,
  grantApproval,
  recordApprovalApproved,
  recordApprovalUnfulfilled,
  requestApproval,
} from "../tools/approval.ts";
import { policyDecide } from "../tools/policy.ts";
import type { ToolSurface } from "../tools/types.ts";
import { loadCategoryIndex } from "../workflows/catalog-view.ts";
import { resolveWorkflowInputContract } from "../workflows/input-schema-synth.ts";
import { resolveWorkflowByIdOrSlug } from "../workflows/lookup.ts";
import { gateWorkflowRunRbac } from "../workflows/rbac.ts";
import { getWorkflow } from "../workflows/service.ts";
import type { AnswerActor } from "./answer-actor.ts";
import {
  type RenderPayload,
  renderConnectorsList,
  renderExecutionsList,
  renderKnowledgeSourcesList,
  renderSchedulesList,
  renderWorkflowCategoryList,
  renderWorkflowsList,
} from "./fast-path-lists.ts";
import { renderRunOutput } from "./fast-path-render.ts";
import { appendMessage, insertToolCall, updateToolCallOutput } from "./persist.ts";
import type { ToolCallOutcome } from "./tools/result-payload.ts";
import type { ConversationStatus, TurnEvent } from "./types.ts";

export type FastPathStatus = "active" | "awaiting_input";

export interface FastPathHit {
  /** True when the matcher consumed the turn; LLM loop should NOT run. */
  status: ConversationStatus;
  /** Buffered events the caller appends to the SSE / persisted stream. */
  events: TurnEvent[];
  /** Pending elicitation id when a confirmation gate fired. */
  pending_elicitation_id?: string;
  /** Tool name we treated this turn as. Drives observability. */
  fast_path_tool: string;
  /** Optional human-facing reply text the assistant message will carry. */
  assistant_text: string | null;
}

export interface FastPathParams {
  db: Db;
  tenant_id: string;
  conversation_id: string;
  actor_id: string | null;
  /**
   * Resolved principal. Required (non-nullable) so the RBAC gates
   * inside this function can run unconditionally — the production
   * caller in `service/run-turn.ts` already drops `principal === null`
   * before reaching here. Making the contract self-documenting
   * removes the "what if principal is null" branch from every
   * RBAC site below.
   */
  principal: ResolvedPrincipal;
  user_message: string;
  /**
   * WHO wrote `user_message`. Only a `human` affirmation grants the approval the
   * confirm gate opened; a `relay` one (the model, over MCP `conversation_append`)
   * merely triggers a claim of what a person already approved out of band.
   * `principal` cannot answer this — both channels authenticate identically.
   */
  answer_actor: AnswerActor;
  /**
   * Surface the turn runs on — mirrors `RunConversationTurnParams.surface`.
   * Scopes local confirmation handles, never creates permission through the
   * transport. All starts additionally use durable workflow-run admission.
   * Defaults to `chat` when absent.
   */
  surface?: "sk_headless" | "sk_interactive" | "mcp" | "web" | "chat";
}

/**
 * Confirmation-resume window: a fast-path "run <slug>" pending envelope
 * is only re-issued via the affirmation branch ("yes" / "ja" / etc.)
 * within this many milliseconds of the prior `tool_calls` row. Older
 * pendings fall through to the LLM so a stale affirmation never
 * resurrects a workflow run from a different topic.
 */
const AFFIRM_RESUME_WINDOW_MS = 5 * 60 * 1000;

// Intent-detection regexes live in `./intent-patterns.ts` — shared with
// `loop.ts` so the two surfaces never drift.
import { AFFIRM_RE, INSPECT_EXEC_RE, RUN_VERB_RE } from "./intent-patterns.ts";

export { RUN_VERB_RE };

const LIST_RES = {
  workflows: [
    /^(?:list|show|display|zeige|welche|wieviele|liste)\s+(?:meine\s+|my\s+|all\s+|alle\s+)?(?:saved\s+|gespeicherte[nr]?\s+)?workflows?\s*\??$/i,
  ],
  connectors: [
    /^(?:list|show|display|zeige|welche|wieviele|liste)\s+(?:meine\s+|my\s+|all\s+|alle\s+)?connectors?\s*\??$/i,
  ],
  executions: [
    /^(?:list|show|display|zeige|welche|wieviele|liste)\s+(?:die\s+|recent\s+|letzte[nr]?\s+|my\s+|meine\s+)?executions?\s*\??$/i,
  ],
  schedules: [
    /^(?:list|show|display|zeige|welche|liste)\s+(?:meine\s+|my\s+|all\s+|alle\s+)?(?:active\s+|aktive[nr]?\s+)?schedules?\s*\??$/i,
  ],
  knowledge_sources: [
    /^(?:list|show|display|zeige|welche|liste)\s+(?:meine\s+|my\s+|all\s+|alle\s+)?(?:knowledge[\s-]?sources?|wissensquellen)\s*\??$/i,
  ],
} as const;

export function matchListIntent(text: string): keyof typeof LIST_RES | null {
  for (const kind of Object.keys(LIST_RES) as Array<keyof typeof LIST_RES>) {
    if (LIST_RES[kind].some((re) => re.test(text))) return kind;
  }
  return null;
}

// Multi-catalog enumeration: "list my connectors and workflows and
// knowledge sources". The single-catalog regexes above are strictly
// anchored, so a combined ask misses them and would otherwise fall to
// the LLM — which, with tools withheld for enumeration, has leaked
// tool-call markup as text. The matcher stays inside the fast-path
// discipline: a list verb followed by ONLY catalog nouns, articles, and
// connectors (and / , / und / & / +). Any other token fails `^…$` and
// falls through to the LLM.
const CATALOG_NOUN_RES: Array<[keyof typeof LIST_RES, RegExp]> = [
  ["workflows", /\bworkflows?\b/i],
  ["connectors", /\bconnectors?\b/i],
  ["executions", /\b(?:executions?|runs?)\b/i],
  ["schedules", /\bschedules?\b/i],
  ["knowledge_sources", /\b(?:knowledge[\s-]?sources?|knowledges?|wissensquellen)\b/i],
];

const MULTI_CATALOG_RE =
  /^(?:list|show|display|view|get|zeige|liste|welche)\s+(?:my|all|the|our|meine|alle|unsere|and|und|sowie|plus|also|,|&|\+|\s|workflows?|connectors?|executions?|runs?|schedules?|knowledge[\s-]?sources?|knowledges?|wissensquellen)+\s*\??$/i;

/**
 * Returns the ordered, de-duplicated set of catalogs named in a pure
 * multi-catalog enumeration (≥2 distinct), or null when the message is
 * not one. Single-catalog asks are left to `matchListIntent`.
 */
function matchMultiCatalog(text: string): Array<keyof typeof LIST_RES> | null {
  if (!MULTI_CATALOG_RE.test(text)) return null;
  const kinds: Array<keyof typeof LIST_RES> = [];
  for (const [kind, re] of CATALOG_NOUN_RES) {
    if (re.test(text) && !kinds.includes(kind)) kinds.push(kind);
  }
  return kinds.length >= 2 ? kinds : null;
}

/** Map a catalog kind to its deterministic renderer. Shared by the
 *  single- and multi-catalog branches so they never drift. */
function rendererFor(kind: keyof typeof LIST_RES): (p: FastPathParams) => Promise<RenderPayload> {
  switch (kind) {
    case "workflows":
      return renderWorkflowsList;
    case "connectors":
      return renderConnectorsList;
    case "executions":
      return renderExecutionsList;
    case "schedules":
      return renderSchedulesList;
    case "knowledge_sources":
      return renderKnowledgeSourcesList;
  }
}

// One catalog block: "zeig mir die notion-Workflows (und was sie tun)",
// "Workflows in @kategorie/notion", "show me the notion workflows",
// "workflows in @category/notion". Anchored like every fast-path matcher; the
// captured word is only a CANDIDATE — `renderWorkflowCategoryList` checks it
// against the live category index and a miss falls through to the model.
const CATEGORY_TOKEN = String.raw`(?:@(?:kategorie|category)\/)?([a-z0-9][a-z0-9_-]*?)`;
const WHAT_THEY_DO = String.raw`(?:\s*,?\s+(?:und\s+was\s+sie\s+tun|and\s+what\s+they\s+do))?`;
const END = String.raw`\s*[?.!]?$`;
const CATEGORY_LIST_RES = [
  new RegExp(
    String.raw`^(?:zeige?|show|list)\s+(?:mir\s+|me\s+)?(?:die\s+|alle\s+|the\s+|all\s+)?${CATEGORY_TOKEN}[-\s]workflows?${WHAT_THEY_DO}${END}`,
    "i",
  ),
  new RegExp(
    String.raw`^(?:(?:zeige?|show|list)\s+(?:mir\s+|me\s+)?)?(?:die\s+|alle\s+|the\s+|all\s+)?workflows?\s+(?:in|aus)\s+(?:der\s+kategorie\s+|the\s+category\s+|category\s+)?${CATEGORY_TOKEN}${WHAT_THEY_DO}${END}`,
    "i",
  ),
];

/** The candidate category word of a single-block listing, lower-cased. */
export function matchCategoryListIntent(text: string): string | null {
  for (const re of CATEGORY_LIST_RES) {
    const m = text.match(re);
    if (m?.[1]) return m[1].toLowerCase();
  }
  return null;
}

/** Canonical conversation-tool slug for a catalog kind (observability). */
function listToolFor(kind: keyof typeof LIST_RES): string {
  return kind === "knowledge_sources" ? "list_knowledge_sources" : `list_${kind}`;
}

// HTTP routes gate the matching list endpoints on these permissions
// (see `apps/engine/src/http/routes/workflows.ts:267`,
// `connectors/index.ts:36`, `executions/list.ts`,
// `knowledge-sources.ts:173`; the schedule:read permission is declared
// in `apps/engine/src/rbac/permissions.json` and enforced via the
// same `can()` evaluator on every surface that touches schedules).
// The fast-path renderers must enforce the same contract so a principal
// who can talk to the chat surface but lacks `*:read` does not see rows
// the HTTP layer would deny.
const READ_PERMISSION_BY_LIST: Record<keyof typeof LIST_RES, string> = {
  workflows: "workflow:read",
  connectors: "connector:read",
  executions: "execution:read",
  schedules: "schedule:read",
  knowledge_sources: "knowledge:read",
};

async function renderInspectExecution(
  p: FastPathParams,
  execution_id: string,
): Promise<RenderPayload> {
  const execRows = await p.db
    .select({
      id: executions.id,
      workflow_id: executions.workflow_id,
      status: executions.status,
      started_at: executions.started_at,
      finished_at: executions.finished_at,
      source_kind: executions.source_kind,
    })
    .from(executions)
    .where(and(eq(executions.tenant_id, p.tenant_id), eq(executions.id, execution_id)))
    .limit(1);
  const exec = execRows[0];
  if (!exec) {
    return {
      ok: false,
      reply: `No execution found with id ${execution_id}.`,
      data: { error: "execution_not_found", execution_id },
    };
  }
  const stepRows = await p.db
    .select({
      step_key: executionSteps.step_key,
      kind: executionSteps.kind,
      status: executionSteps.status,
      duration_ms: executionSteps.duration_ms,
    })
    .from(executionSteps)
    .where(
      and(eq(executionSteps.tenant_id, p.tenant_id), eq(executionSteps.execution_id, execution_id)),
    )
    .orderBy(asc(executionSteps.started_at));
  const stepLines = stepRows.map(
    (s) =>
      `- ${s.step_key} (${s.kind}) ${s.status}${s.duration_ms != null ? ` · ${s.duration_ms}ms` : ""}`,
  );
  return {
    ok: exec.status === "succeeded",
    reply: `Execution ${exec.id.slice(0, 8)} — ${exec.status}\n${stepLines.join("\n") || "(no steps)"}`,
    data: {
      execution: exec,
      steps: stepRows,
    },
  };
}

/**
 * Persist the fast-path tool call (input + output) and the assistant
 * message anchor so the audit trail mirrors a normal LLM turn. The
 * `tool` name here is the canonical conversation-tool slug (e.g.
 * `list_workflows`, `run_workflow`, `inspect_execution`) — the LLM
 * never ran, but downstream observability dashboards key on the same
 * tool name.
 */
async function persistFastPathTurn(
  p: FastPathParams,
  tool: string,
  input: Record<string, unknown>,
  output: Record<string, unknown>,
  reply: string,
  /** How this fast-path call ended. The fast path builds its output envelope
   *  by hand rather than from a `ToolResult`, so there is nothing to classify
   *  and the caller states it. Keep it identical to the `outcome` the
   *  adjacent `recordConversationToolCall` reports. */
  outcome: ToolCallOutcome,
  /** Engine-only bookkeeping — never replayed into LLM context, never projected
   *  to a client. The confirm gate parks its approval id here. */
  confirmation_data?: Record<string, unknown>,
): Promise<{ events: TurnEvent[]; assistant_message_id: string; tool_call_id: string }> {
  const assistantMessageId = await appendMessage(
    p.db,
    p.tenant_id,
    p.conversation_id,
    "assistant",
    { text: reply, fast_path: true },
  );
  const toolCallId = await insertToolCall(p.db, {
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    parent_message_id: assistantMessageId,
    tool,
    input,
    approval_required: false,
    ...(confirmation_data ? { confirmation_data } : {}),
  });
  await updateToolCallOutput(p.db, toolCallId, output, outcome);
  await appendMessage(p.db, p.tenant_id, p.conversation_id, "tool", { tool, output });
  const events: TurnEvent[] = [
    {
      type: "tool_call_start",
      call_id: toolCallId,
      tool,
      input_partial: input,
      parent_message_id: assistantMessageId,
    },
    {
      type: "tool_call_end",
      call_id: toolCallId,
      input,
      parent_message_id: assistantMessageId,
    },
    {
      type: "tool_result",
      call_id: toolCallId,
      tool,
      output,
      parent_message_id: assistantMessageId,
    },
    {
      type: "message",
      role: "assistant",
      content: reply,
      id: assistantMessageId,
    },
  ];
  return { events, assistant_message_id: assistantMessageId, tool_call_id: toolCallId };
}

/**
 * Write a POLICY_DENIED audit row for a fast-path read deny. Mirrors
 * what the HTTP middleware does — without this, an operator scanning
 * the audit log cannot distinguish a chat deny from a no-op fall-through.
 *
 * Per-resource denials (`inspect_execution`, future per-row reads) pass
 * the matching resource_type + resource_id so audit aggregations stay
 * comparable with the HTTP layer's row shape. List-level denials default
 * to the conversation as the resource because there's no single resource
 * id at fault.
 */
async function auditPolicyDenied(
  p: FastPathParams,
  permission: string,
  tool: string,
  reason: string,
  resource?: { type: string; id: string },
): Promise<void> {
  // `FastPathParams.principal` is non-nullable; collapse to direct
  // access so the audit row's actor matches the type contract.
  await auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: p.principal.kind === "user" ? "user" : "system",
      actor_id: p.principal.id,
      action: AuditAction.POLICY_DENIED,
      resource_type: resource?.type ?? "conversation",
      resource_id: resource?.id ?? p.conversation_id,
      result: "denied",
      reason,
      metadata: {
        tool,
        via: "fast_path",
        provider: p.principal.provider,
        permission,
      },
    },
    p.db,
  );
}

interface RunFastPathResolution {
  workflow: { id: string; slug: string; name: string; current_version_id: string | null };
}

async function executeRunWorkflow(
  p: FastPathParams,
  resolution: RunFastPathResolution,
  input: unknown,
): Promise<RenderPayload & { outcome: ToolCallOutcome }> {
  // Authenticated production calls always carry both principal AND
  // actor_id together (both come from the same auth resolution). If a
  // principal made it this far but actor_id is null, an upstream caller
  // dropped the actor — surface it loudly instead of silently writing
  // `system` to the audit trail. We log a warning rather than throw so
  // the operator gets actionable diagnostics; the throw was too strict
  // for test fixtures that legitimately seed principal without seeding
  // a users-table row for the FK.
  if (p.actor_id === null) {
    logger.warn({
      module: "conversation",
      action: "fast_path.actor_id_missing",
      msg: "fast-path executeRunWorkflow invoked with actor_id=null — audit row will fall back to actor_type=system",
      tenant_id: p.tenant_id,
      principal_id: p.principal.id,
    });
  }
  const wf = resolution.workflow;
  try {
    // A known slug or an affirmation is not a live execution authority. Use
    // the same admission boundary as REST: reserve a matching local grant,
    // otherwise persist a held preparation. Bind the version resolved above
    // so concurrent activation cannot substitute a different DAG.
    const admitted = await admitWorkflowRun(
      {
        tenant_id: p.tenant_id,
        workflow_id: wf.id,
        workflow_version_id: wf.current_version_id ?? undefined,
        execution_environment: "dev",
        request_source: "chat",
        input: input ?? null,
      },
      p.db,
    );
    const result = await runExecution({
      db: p.db,
      tenant_id: p.tenant_id,
      source: {
        kind: "saved",
        workflow_id: wf.id,
        version_id: admitted.workflow_version_id,
      },
      input: admitted.input,
      options: {
        request_source: "chat",
        trace_id: null,
        principal: p.principal,
        execution_mode: "dev",
        existing_execution_id: admitted.execution_id,
        hold_writes: admitted.hold_writes,
      },
    });
    const heldPreview = result.warnings?.find(
      (warning) => warning.code === HELD_PREVIEW_WARNING_CODE,
    );
    const ok = result.status === "succeeded" && !heldPreview;
    const warningCount = result.warnings?.length ?? 0;
    const warningLine =
      warningCount > 0
        ? `${warningCount} warning(s): ${Array.from(
            new Set((result.warnings ?? []).map((w) => w.code)),
          )
            .sort()
            .join(", ")}`
        : null;

    let reply: string;
    if (heldPreview) {
      const german = /^(?:starte|f[uü]hre|ja|jo|los|bestätigt)\b/i.test(p.user_message.trim());
      reply = german
        ? `Vorschau für ${wf.slug}: Es wurde nichts geschrieben. Prüfe vor einem Live-Lauf die Ausführungsfreigabe des Workflows.`
        : `Preview of ${wf.slug}: Nothing was written. Review the workflow's execution authority before a live run.`;
    } else if (ok) {
      // Lead with the actual result, not a step-by-step execution trace —
      // a chat user asked for the outcome, not a CI-style log. The full
      // step list still rides in the `data` payload for anyone who wants
      // to inspect it, and a failed run (below) keeps the trace inline
      // for diagnosis.
      const rendered = renderRunOutput(result.output);
      reply = rendered ?? `Ran ${wf.slug}: succeeded`;
      if (warningLine) reply += `\n\n${warningLine}`;
    } else {
      // A non-succeeded run wants its step breakdown inline for diagnosis.
      const stepLines = result.steps.map(
        (s) =>
          `- ${s.step_key} (${s.kind}) ${s.status}${s.duration_ms != null ? ` · ${s.duration_ms}ms` : ""}`,
      );
      const parts = [`Ran ${wf.slug}: ${result.status}`, ...stepLines];
      if (warningLine) parts.push(warningLine);
      reply = parts.join("\n");
    }
    return {
      ok,
      // A completed preparation is normal activity, not a failed call or a
      // newly opened approval. The output still says no external action ran.
      outcome: result.status === "succeeded" ? "ok" : "error",
      reply,
      data: {
        status: result.status,
        execution_id: result.execution_id,
        workflow_id: wf.id,
        workflow_slug: wf.slug,
        workflow_version_id: admitted.workflow_version_id,
        execution_authority_id: admitted.execution_authority_id,
        hold_writes: admitted.hold_writes,
        ...(heldPreview ? { preview: true, writes_held: true } : {}),
        output: result.output,
        warnings: result.warnings ?? [],
        suggested_command: `/workflows run ${wf.slug}`,
        next_best_actions:
          result.status === "succeeded"
            ? ["inspect_execution_step", "run_workflow"]
            : ["diagnose_latest_execution", "inspect_workflow"],
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      outcome: "error",
      reply: `Run of ${wf.slug} failed: ${msg}`,
      data: { status: "failed", workflow_id: wf.id, error: msg },
    };
  }
}

/**
 * Try to handle the user message without invoking the LLM. Returns
 * `null` when no rule matches — the caller then runs the normal model
 * loop. Returns a `FastPathHit` when the matcher consumed the turn;
 * the caller appends `events` to its event stream and short-circuits.
 *
 * The `run <slug>` branch follows the same two-turn confirmation gate MCP
 * enforces: the first turn mints an UNGRANTED approval and ends the turn; a
 * PERSON's affirmation grants it, claims it, and replays the args it was granted
 * for. Neither the `confirm_id` nor the approval's portal token ever leaves the
 * engine on this surface: the affirmation is prose, and the handle is read back
 * off the tool-call row's `confirmation_data`.
 */
/**
 * Mirror the HTTP route's `*:read` gate for a catalog read. A principal who
 * lacks it gets a deterministic deny (audited, no fall-through to the LLM), so
 * chat never enumerates what the HTTP layer would refuse. Null = allowed.
 */
async function denyCatalogRead(
  p: FastPathParams,
  permission: string,
  tool: string,
  input: Record<string, unknown>,
): Promise<FastPathHit | null> {
  const decision = await can(p.db, { tenant_id: p.tenant_id, principal: p.principal, permission });
  if (decision.allow) return null;
  const reason = decision.reason ?? "permission_denied";
  await auditPolicyDenied(p, permission, tool, reason);
  const reply = `Permission denied: ${permission}.`;
  const persisted = await persistFastPathTurn(
    p,
    tool,
    input,
    { ok: false, denied: true, permission, reason, skipped_llm: true },
    reply,
    "denied",
  );
  recordConversationToolCall({ category: "tenant_read", tool, outcome: "denied", duration_ms: 0 });
  return {
    status: "active",
    events: persisted.events,
    fast_path_tool: tool,
    assistant_text: reply,
  };
}

/** Persist + report a rendered catalog read as the turn's answer. */
async function answerCatalogRead(
  p: FastPathParams,
  tool: string,
  input: Record<string, unknown>,
  payload: RenderPayload,
): Promise<FastPathHit> {
  const outcome = payload.ok ? "ok" : "error";
  const persisted = await persistFastPathTurn(
    p,
    tool,
    input,
    { ok: payload.ok, ...payload.data, skipped_llm: true },
    payload.reply,
    outcome,
  );
  recordConversationToolCall({ category: "tenant_read", tool, outcome, duration_ms: 0 });
  logger.info({
    module: "conversation",
    action: "conversation.fast_path",
    msg: "fast-path handled list intent",
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    tool,
    ...input,
  });
  return {
    status: "active",
    events: persisted.events,
    fast_path_tool: tool,
    assistant_text: payload.reply,
  };
}

export async function tryFastPath(p: FastPathParams): Promise<FastPathHit | null> {
  const text = p.user_message.trim();
  if (text.length === 0) return null;
  // The confirm-gate surface for this turn. `policyDecide`, `requestApproval`,
  // and `consumeApproval` speak `ToolSurface` ("chat" | "mcp"). This scopes
  // local approval handles; neither surface bypasses durable run admission.
  const gateSurface: ToolSurface = p.surface === "mcp" ? "mcp" : "chat";

  // List intents — always emit a deterministic answer.
  const listKind = matchListIntent(text);
  if (listKind) {
    const tool = listToolFor(listKind);
    // Mirror the HTTP route's `*:read` gate so a principal who lacks
    // the corresponding permission cannot enumerate via chat what the
    // HTTP layer would deny. The deny is deterministic (no fall-through
    // to the LLM) so the contract is closed at the fast-path boundary.
    const denied = await denyCatalogRead(p, READ_PERMISSION_BY_LIST[listKind], tool, {});
    if (denied) return denied;
    return answerCatalogRead(p, tool, {}, await rendererFor(listKind)(p));
  }

  // One catalog block ("zeig mir die notion-Workflows"). A word that is not a
  // live category ("failed", "my", "aktiven") falls through BEFORE the gate:
  // it is not a catalog read, so it earns no permission denial and no audit
  // row. A live one takes the same `workflow:read` gate as the full list.
  const categoryCandidate = matchCategoryListIntent(text);
  if (categoryCandidate) {
    const index = await loadCategoryIndex(p.tenant_id, p.db);
    if ([...index.values()].includes(categoryCandidate)) {
      const input = { category: categoryCandidate };
      const denied = await denyCatalogRead(p, "workflow:read", "list_workflows", input);
      if (denied) return denied;
      const payload = await renderWorkflowCategoryList(p, categoryCandidate, index);
      if (payload) return answerCatalogRead(p, "list_workflows", input, payload);
    }
  }

  // Multi-catalog enumeration ("connectors and workflows and knowledge
  // sources") — render every named catalog deterministically. Each is
  // gated on its own `*:read` permission (mirroring the single-catalog
  // branch); a denied catalog renders its deny line + audit row while
  // the rest still render. This keeps the whole enumeration off the LLM,
  // so it cannot leak tool-call markup for a catalog the snapshot lacked.
  const multiKinds = matchMultiCatalog(text);
  if (multiKinds) {
    const sections: string[] = [];
    const dataByKind: Record<string, unknown> = {};
    let anyOk = false;
    for (const kind of multiKinds) {
      const permission = READ_PERMISSION_BY_LIST[kind];
      const decision = await can(p.db, {
        tenant_id: p.tenant_id,
        principal: p.principal,
        permission,
      });
      if (!decision.allow) {
        const reason = decision.reason ?? "permission_denied";
        await auditPolicyDenied(p, permission, listToolFor(kind), reason);
        sections.push(`Permission denied: ${permission}.`);
        dataByKind[kind] = { ok: false, denied: true, permission, reason };
        continue;
      }
      const payload = await rendererFor(kind)(p);
      sections.push(payload.reply);
      dataByKind[kind] = { ok: payload.ok, ...payload.data };
      anyOk = anyOk || payload.ok;
    }
    const reply = sections.join("\n\n");
    const persisted = await persistFastPathTurn(
      p,
      "list_catalogs",
      { catalogs: multiKinds },
      { ok: anyOk, catalogs: dataByKind, skipped_llm: true },
      reply,
      anyOk ? "ok" : "error",
    );
    recordConversationToolCall({
      category: "tenant_read",
      tool: "list_catalogs",
      outcome: anyOk ? "ok" : "error",
      duration_ms: 0,
    });
    logger.info({
      module: "conversation",
      action: "conversation.fast_path",
      msg: "fast-path handled multi-catalog list intent",
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      catalogs: multiKinds,
    });
    return {
      status: "active",
      events: persisted.events,
      fast_path_tool: "list_catalogs",
      assistant_text: reply,
    };
  }

  const inspectMatch = text.match(INSPECT_EXEC_RE);
  if (inspectMatch) {
    const execId = inspectMatch[2];
    if (execId) {
      // Mirror the HTTP route's `execution:read` gate the same way the
      // list-intent branch does for `*:read`. The HTTP equivalents at
      // `apps/engine/src/http/routes/executions/list.ts` enforce this
      // per-resource; the fast-path must agree.
      {
        const decision = await can(p.db, {
          tenant_id: p.tenant_id,
          principal: p.principal,
          permission: "execution:read",
          resource: { type: "execution", id: execId },
        });
        if (!decision.allow) {
          const reason = decision.reason ?? "permission_denied";
          await auditPolicyDenied(p, "execution:read", "inspect_execution", reason, {
            type: "execution",
            id: execId,
          });
          const reply = `Permission denied: execution:read.`;
          const persisted = await persistFastPathTurn(
            p,
            "inspect_execution",
            { execution_id: execId },
            {
              ok: false,
              denied: true,
              permission: "execution:read",
              reason,
              skipped_llm: true,
            },
            reply,
            "denied",
          );
          recordConversationToolCall({
            category: "tenant_read",
            tool: "inspect_execution",
            outcome: "denied",
            duration_ms: 0,
          });
          return {
            status: "active",
            events: persisted.events,
            fast_path_tool: "inspect_execution",
            assistant_text: reply,
          };
        }
      }
      const payload = await renderInspectExecution(p, execId);
      const persisted = await persistFastPathTurn(
        p,
        "inspect_execution",
        { execution_id: execId },
        { ok: payload.ok, ...payload.data, skipped_llm: true },
        payload.reply,
        payload.ok ? "ok" : "error",
      );
      recordConversationToolCall({
        category: "tenant_read",
        tool: "inspect_execution",
        outcome: payload.ok ? "ok" : "error",
        duration_ms: 0,
      });
      return {
        status: "active",
        events: persisted.events,
        fast_path_tool: "inspect_execution",
        assistant_text: payload.reply,
      };
    }
  }

  const runMatch = text.match(RUN_VERB_RE);
  if (runMatch) {
    const slugOrId = runMatch[2];
    if (slugOrId) {
      // `require_published: true` mirrors MCP's catalog filter — a slug
      // that resolves only to a draft is treated as "not found" and
      // falls through to the LLM, instead of bypassing the contract.
      const resolved = await resolveWorkflowByIdOrSlug(p.db, p.tenant_id, slugOrId, {
        require_published: true,
      });
      if (!resolved?.current_version_id) {
        // Unknown slug — fall through to LLM (the model can suggest
        // alternatives or surface the right slug). Same shape as the
        // run_workflow tool's "workflow_not_found" branch handles it.
        return null;
      }
      // The fast path always runs with `input: null` — a workflow whose
      // input contract (see resolveWorkflowInputContract) requires keys
      // cannot complete here. Defer to the LLM loop, where run_workflow
      // pauses with the auto-generated input form. Pre-fix this branch
      // ran anyway and failed with "$input: required field missing".
      const wfView = await getWorkflow(p.tenant_id, resolved.id, p.db);
      if (wfView && resolveWorkflowInputContract(wfView.definition) !== null) {
        logger.info({
          module: "conversation",
          action: "fast_path.deferred_input_required",
          tenant_id: p.tenant_id,
          conversation_id: p.conversation_id,
          workflow_id: resolved.id,
        });
        return null;
      }
      // Canonical RBAC gate — identical contract to MCP's `wf_<slug>`
      // dispatch. See `workflows/rbac.ts`. A POLICY_DENIED audit row
      // is committed before this returns; the persisted tool-call row
      // tells the operator + transcript reader why the run did not fire.
      const rbac = await gateWorkflowRunRbac({
        db: p.db,
        principal: p.principal,
        workflow_id: resolved.id,
        workflow_slug: resolved.slug,
        request_source: "fast_path",
        tool: "run_workflow",
      });
      if (!rbac.allow) {
        const reply = `Permission denied: ${rbac.error_message}.`;
        const persisted = await persistFastPathTurn(
          p,
          "run_workflow",
          { workflow: resolved.slug, environment: "dev" },
          {
            ok: false,
            denied: true,
            permission: "workflow:run",
            reason: rbac.reason,
            error: rbac.error_message,
            skipped_llm: true,
          },
          reply,
          "denied",
        );
        recordConversationToolCall({
          category: "tenant_write",
          tool: "run_workflow",
          outcome: "denied",
          duration_ms: 0,
        });
        return {
          status: "active",
          events: persisted.events,
          fast_path_tool: "run_workflow",
          assistant_text: reply,
        };
      }
      // The ONE confirm gate. `not_available_on_surface` is unreachable for
      // (tenant_write, chat) — the gate only withholds `draft_write` on MCP.
      const runArgs = { workflow: resolved.slug, environment: "dev" };
      const gate = policyDecide({
        tool: "run_workflow",
        category: "tenant_write",
        surface: gateSurface,
        args: runArgs,
      });
      if (gate.kind === "needs_confirm") {
        // The approval persists these args (encrypted) under `confirm_id` and
        // stamps APPROVAL_REQUESTED, UNGRANTED. The affirmation branch below
        // claims it and REPLAYS them — nothing the operator's "yes" carries
        // participates in what runs.
        const confirm_id = gate.envelope.tool_call_id;
        await requestApproval({
          db: p.db,
          principal: p.principal,
          approval_id: confirm_id,
          tool: "run_workflow",
          surface: gateSurface,
          via: "fast_path",
          reason: gate.envelope.reason,
          // `executeRunWorkflow` runs the fast path in dev, always.
          execution_mode: "dev",
          args: runArgs,
        });
        const persisted = await persistFastPathTurn(
          p,
          "run_workflow",
          runArgs,
          {
            ok: false,
            pending: true,
            status: "awaiting_confirmation",
            policy_mode: "confirm_before_execution",
            confirm_required: true,
            pending_output: gate.envelope.pending_output,
            // Neither `confirm_id` NOR `approval_url`. This envelope is persisted
            // on `conversation_tool_calls.output` and on a `tool`-role message,
            // both of which `buildModelMessages` replays into LLM context — and
            // the chat palette can make outbound HTTP calls, so a grant token in
            // that context would be a live capability. The affirmation branch
            // reads the handle off `confirmation_data` instead, the engine's own
            // record of what it is holding, and the person's "yes" in this
            // channel is the grant.
            resume: `A person must approve this by replying "yes" here — the engine replays the arguments it already holds. Nothing runs until they do; you cannot approve on their behalf.`,
            skipped_llm: true,
            suggested_command: `/workflows run ${resolved.slug}`,
          },
          `Confirm: run ${resolved.slug} in dev?`,
          "pending",
          { approval_id: confirm_id },
        );
        // The pending envelope is NOT a denial — the operator may yet
        // approve. Reporting `denied` would skew the run-vs-deny ratio
        // on the conversation_tool_calls_total counter.
        recordConversationToolCall({
          category: "tenant_write",
          tool: "run_workflow",
          outcome: "pending",
          duration_ms: 0,
        });
        // No `pending_elicitation_id`: this gate opened an approval, not a
        // `conversation_elicitations` row, so there is nothing for a client to
        // POST an answer to — and the approval id is not a value the model may
        // hold. The turn ends `awaiting_input`; the operator answers in chat.
        return {
          status: "awaiting_input",
          events: persisted.events,
          fast_path_tool: "run_workflow",
          assistant_text: `Confirm: run ${resolved.slug} in dev?`,
        };
      }
      const payload = await executeRunWorkflow(p, { workflow: resolved }, null);
      const persisted = await persistFastPathTurn(
        p,
        "run_workflow",
        { workflow: resolved.slug, environment: "dev" },
        { ok: payload.ok, ...payload.data, skipped_llm: true },
        payload.reply,
        payload.outcome,
      );
      // `runExecution` already emits its own execution audit row.
      // We previously stamped a CONVERSATION_COMMITTED row here, but
      // that action is reserved for workflow-commit moments (draft →
      // persisted) — see `service/run-turn.ts:145-158`. Dropping the
      // extra row keeps audit semantics aligned across surfaces.
      recordConversationToolCall({
        category: "tenant_write",
        tool: "run_workflow",
        outcome: payload.outcome,
        duration_ms: 0,
      });
      logger.info({
        module: "conversation",
        action: "conversation.fast_path",
        msg: "fast-path executed run_workflow",
        tenant_id: p.tenant_id,
        conversation_id: p.conversation_id,
        workflow_id: resolved.id,
        slug: resolved.slug,
      });
      return {
        status: "active",
        events: persisted.events,
        fast_path_tool: "run_workflow",
        assistant_text: payload.reply,
      };
    }
  }

  // Confirmation-resume branch: when the just-stored user message is a
  // plain affirmation ("yes", "ja", "approve") and the previous turn
  // emitted a fast-path `run_workflow` pending envelope, grant-if-human and then
  // claim the approval that envelope minted, and run what it was granted for.
  // The affirmation carries no payload — the args come out of the approval,
  // which is single-use, tenant-, principal- and tool-bound.
  if (AFFIRM_RE.test(text)) {
    const recent = await p.db
      .select({
        id: conversationToolCalls.id,
        tool: conversationToolCalls.tool,
        output: conversationToolCalls.output,
        // The approval handle lives HERE, not on `output`: `output` is replayed
        // into LLM context by `buildModelMessages`, `confirmation_data` is not.
        confirmation_data: conversationToolCalls.confirmation_data,
        created_at: conversationToolCalls.created_at,
      })
      .from(conversationToolCalls)
      .where(
        and(
          eq(conversationToolCalls.tenant_id, p.tenant_id),
          eq(conversationToolCalls.conversation_id, p.conversation_id),
          eq(conversationToolCalls.tool, "run_workflow"),
        ),
      )
      .orderBy(desc(conversationToolCalls.created_at))
      .limit(1);
    const head = recent[0];
    const headOutput = head?.output as { pending?: unknown } | null;
    const headConfirmation = head?.confirmation_data as { approval_id?: unknown } | null;
    const approvalId =
      typeof headConfirmation?.approval_id === "string" ? headConfirmation.approval_id : null;
    if (
      head &&
      headOutput?.pending === true &&
      approvalId !== null &&
      Date.now() - (head.created_at?.getTime() ?? 0) < AFFIRM_RESUME_WINDOW_MS
    ) {
      // The person who typed "yes" IS the approver, and chat is their channel.
      // A relay affirmation (the MODEL wrote this "user message" through
      // `conversation_append` on MCP) grants nothing: the claim below then
      // refuses with `approval_not_granted` unless a person already granted this
      // approval in the portal. Affirming is a trigger, never a decision.
      if (p.answer_actor.kind === "human") {
        const granted = await grantApproval({
          db: p.db,
          approval_id: approvalId,
          tenant_id: p.tenant_id,
          granted_by_user_id: p.answer_actor.user_id,
          via: p.answer_actor.via,
        });
        if (!granted.ok) {
          logger.warn({
            module: "conversation",
            action: "fast_path.approval_grant_missed",
            msg: "a person affirmed the fast-path run but the grant did not land; the claim decides the outcome",
            tenant_id: p.tenant_id,
            conversation_id: p.conversation_id,
            approval_id: approvalId,
            user_id: p.answer_actor.user_id,
            error_code: granted.code,
          });
        }
      } else {
        logger.warn({
          module: "conversation",
          action: "fast_path.affirmation_not_human",
          msg: "a non-human actor affirmed a held fast-path run; nothing was granted and the claim will refuse unless a person granted it in the approval portal",
          tenant_id: p.tenant_id,
          conversation_id: p.conversation_id,
          approval_id: approvalId,
          relay_reason: p.answer_actor.reason,
        });
      }
      // Claim before anything else, exactly as the dispatcher does: the
      // approval is what authorizes this run, and it is single-use. A later
      // RBAC denial therefore burns it — the operator re-issues "run <slug>"
      // and confirms again, which is the honest outcome for a revoked grant.
      // The claim is not the approval: APPROVAL_APPROVED lands below, once the
      // RBAC gate has passed.
      const claim = await consumeApproval({
        db: p.db,
        principal: p.principal,
        approval_id: approvalId,
        tool: "run_workflow",
        surface: gateSurface,
        via: "fast_path",
        execution_mode: "dev",
      });
      if (!claim.ok) {
        const persisted = await persistFastPathTurn(
          p,
          "run_workflow",
          {},
          { ok: false, error_code: claim.code, message: claim.message, skipped_llm: true },
          claim.message,
          "error",
        );
        recordConversationToolCall({
          category: "tenant_write",
          tool: "run_workflow",
          outcome: "error",
          duration_ms: 0,
        });
        return {
          status: "active",
          events: persisted.events,
          fast_path_tool: "run_workflow",
          assistant_text: claim.message,
        };
      }
      // The replay payload. The approval was granted over these args and
      // nothing else; the affirmation contributed no data.
      const replayArgs = claim.args;
      const slug = typeof replayArgs.workflow === "string" ? replayArgs.workflow : null;
      const resolved = slug
        ? await resolveWorkflowByIdOrSlug(p.db, p.tenant_id, slug, { require_published: true })
        : null;
      if (!resolved?.current_version_id) {
        // The workflow was unpublished or deleted between the pending
        // envelope and the approval. The approval is spent; say so rather
        // than falling through to a model turn that cannot see it — and close
        // its lifecycle on the approval id, so a spent handle never reads as an
        // approval that simply stopped being written about.
        await recordApprovalUnfulfilled({
          db: p.db,
          principal: p.principal,
          claim,
          tool: "run_workflow",
          via: "fast_path",
          reason: "workflow_not_found",
        });
        const reply = `The workflow ${slug ?? "(unknown)"} is no longer available; nothing was run.`;
        const persisted = await persistFastPathTurn(
          p,
          "run_workflow",
          replayArgs,
          { ok: false, error: "workflow_not_found", skipped_llm: true },
          reply,
          "error",
        );
        recordConversationToolCall({
          category: "tenant_write",
          tool: "run_workflow",
          outcome: "error",
          duration_ms: 0,
        });
        return {
          status: "active",
          events: persisted.events,
          fast_path_tool: "run_workflow",
          assistant_text: reply,
        };
      }
      // Canonical RBAC gate — the resume branch must check the same
      // permission MCP enforces. Without this, an operator whose role
      // changed between the pending request and the approval could bypass
      // `workflow:run` denial.
      const rbac = await gateWorkflowRunRbac({
        db: p.db,
        principal: p.principal,
        workflow_id: resolved.id,
        workflow_slug: resolved.slug,
        request_source: "fast_path",
        tool: "run_workflow",
        approval: approvalAuditResource(claim),
      });
      if (!rbac.allow) {
        const reply = `Permission denied: ${rbac.error_message}.`;
        const persisted = await persistFastPathTurn(
          p,
          "run_workflow",
          replayArgs,
          {
            ok: false,
            denied: true,
            permission: "workflow:run",
            reason: rbac.reason,
            error: rbac.error_message,
            skipped_llm: true,
          },
          reply,
          "denied",
        );
        recordConversationToolCall({
          category: "tenant_write",
          tool: "run_workflow",
          outcome: "denied",
          duration_ms: 0,
        });
        return {
          status: "active",
          events: persisted.events,
          fast_path_tool: "run_workflow",
          assistant_text: reply,
        };
      }
      // Authorized — now the approval is real. Refuse to run when its audit row
      // cannot be persisted; an unrecorded approved run is the governance gap
      // the log exists to close.
      const approvalRecorded = await recordApprovalApproved({
        db: p.db,
        principal: p.principal,
        claim,
        tool: "run_workflow",
        via: "fast_path",
      });
      if (!approvalRecorded) {
        const reply = `The confirmation could not be recorded in the audit log; ${resolved.slug} was not run. Ask again to obtain a fresh confirmation.`;
        const persisted = await persistFastPathTurn(
          p,
          "run_workflow",
          replayArgs,
          { ok: false, error_code: "approval_audit_failed", skipped_llm: true },
          reply,
          "error",
        );
        recordConversationToolCall({
          category: "tenant_write",
          tool: "run_workflow",
          outcome: "error",
          duration_ms: 0,
        });
        return {
          status: "active",
          events: persisted.events,
          fast_path_tool: "run_workflow",
          assistant_text: reply,
        };
      }
      const payload = await executeRunWorkflow(p, { workflow: resolved }, null);
      const persisted = await persistFastPathTurn(
        p,
        "run_workflow",
        replayArgs,
        { ok: payload.ok, ...payload.data, skipped_llm: true },
        payload.reply,
        payload.outcome,
      );
      recordConversationToolCall({
        category: "tenant_write",
        tool: "run_workflow",
        outcome: payload.outcome,
        duration_ms: 0,
      });
      logger.info({
        module: "conversation",
        action: "conversation.fast_path",
        msg: "fast-path resumed run_workflow after confirmation",
        tenant_id: p.tenant_id,
        conversation_id: p.conversation_id,
        workflow_id: resolved.id,
      });
      return {
        status: "active",
        events: persisted.events,
        fast_path_tool: "run_workflow",
        assistant_text: payload.reply,
      };
    }
  }
  return null;
}
