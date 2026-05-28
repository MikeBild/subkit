// Engine fast-path matcher. Skips the LLM turn entirely for a
// whitelisted set of deterministic intents that the LLM would
// otherwise round-trip through 3–5 tool calls just to answer.
//
// Whitelist v1:
//   - `list workflows | connectors | executions | schedules |
//      knowledge sources` (en + de) → render from tenant rows
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
//     and `gateTenantToolCall(via: "fast_path")`, so the RBAC
//     decision + APPROVAL_* audit rows match MCP exactly — no "known
//     slug" exemption. The list-side renderers gate on the same
//     `*:read` permissions the HTTP routes enforce.

import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import {
  connectors,
  conversationToolCalls,
  executionSteps,
  executions,
  knowledgeSources,
  workflows,
  workflowsSchedules,
} from "../db/schema/index.ts";
import { runExecution } from "../execution/engine.ts";
import { logger } from "../logging/logger.ts";
import { gateTenantToolCall } from "../mcp/capabilities/policy-gate.ts";
import { recordConversationToolCall } from "../observability/instrumentation.ts";
import { can } from "../rbac/evaluator.ts";
import { resolveWorkflowByIdOrSlug } from "../workflows/lookup.ts";
import { gateWorkflowRunRbac } from "../workflows/rbac.ts";
import { appendMessage, insertToolCall, updateToolCallOutput } from "./persist.ts";
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

const LIST_LIMIT = 10;

function matchListIntent(text: string): keyof typeof LIST_RES | null {
  for (const kind of Object.keys(LIST_RES) as Array<keyof typeof LIST_RES>) {
    if (LIST_RES[kind].some((re) => re.test(text))) return kind;
  }
  return null;
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

interface RenderPayload {
  ok: boolean;
  reply: string;
  data: Record<string, unknown>;
}

async function renderWorkflowsList(p: FastPathParams): Promise<RenderPayload> {
  const rows = await p.db
    .select({
      id: workflows.id,
      slug: workflows.slug,
      name: workflows.name,
      lifecycle: workflows.lifecycle,
    })
    .from(workflows)
    .where(and(eq(workflows.tenant_id, p.tenant_id), isNull(workflows.deleted_at)))
    .orderBy(desc(workflows.last_executed_at), asc(workflows.created_at))
    .limit(LIST_LIMIT);
  if (rows.length === 0) {
    return {
      ok: true,
      reply: "No saved workflows yet.",
      data: { items: [] },
    };
  }
  const lines = rows.map((r) => `- ${r.slug} (${r.lifecycle}) — ${r.name}`);
  return {
    ok: true,
    reply: `${rows.length} workflow${rows.length === 1 ? "" : "s"}:\n${lines.join("\n")}`,
    data: { items: rows },
  };
}

async function renderConnectorsList(p: FastPathParams): Promise<RenderPayload> {
  const rows = await p.db
    .select({
      id: connectors.id,
      slug: connectors.slug,
      display_name: connectors.display_name,
      driver: connectors.driver,
      environment: connectors.environment,
    })
    .from(connectors)
    .where(and(eq(connectors.tenant_id, p.tenant_id), isNull(connectors.deleted_at)))
    .orderBy(asc(connectors.created_at))
    .limit(LIST_LIMIT);
  if (rows.length === 0) {
    return { ok: true, reply: "No connectors yet.", data: { items: [] } };
  }
  const lines = rows.map((r) => `- ${r.slug} (${r.driver}/${r.environment}) — ${r.display_name}`);
  return {
    ok: true,
    reply: `${rows.length} connector${rows.length === 1 ? "" : "s"}:\n${lines.join("\n")}`,
    data: { items: rows },
  };
}

async function renderExecutionsList(p: FastPathParams): Promise<RenderPayload> {
  const rows = await p.db
    .select({
      id: executions.id,
      workflow_id: executions.workflow_id,
      status: executions.status,
      started_at: executions.started_at,
      source_kind: executions.source_kind,
    })
    .from(executions)
    .where(eq(executions.tenant_id, p.tenant_id))
    .orderBy(desc(executions.created_at))
    .limit(LIST_LIMIT);
  if (rows.length === 0) {
    return { ok: true, reply: "No executions yet.", data: { items: [] } };
  }
  const lines = rows.map(
    (r) =>
      `- ${r.id.slice(0, 8)} ${r.status} (${r.source_kind})${r.started_at ? ` · ${r.started_at.toISOString()}` : ""}`,
  );
  return {
    ok: true,
    reply: `${rows.length} recent execution${rows.length === 1 ? "" : "s"}:\n${lines.join("\n")}`,
    data: { items: rows },
  };
}

async function renderSchedulesList(p: FastPathParams): Promise<RenderPayload> {
  const rows = await p.db
    .select({
      id: workflowsSchedules.id,
      workflow_id: workflowsSchedules.workflow_id,
      cron: workflowsSchedules.cron,
      timezone: workflowsSchedules.timezone,
      paused: workflowsSchedules.paused,
    })
    .from(workflowsSchedules)
    .where(eq(workflowsSchedules.tenant_id, p.tenant_id))
    .orderBy(asc(workflowsSchedules.created_at))
    .limit(LIST_LIMIT);
  if (rows.length === 0) {
    return { ok: true, reply: "No schedules yet.", data: { items: [] } };
  }
  const lines = rows.map(
    (r) => `- ${r.id.slice(0, 8)} ${r.cron} ${r.timezone}${r.paused ? " (paused)" : ""}`,
  );
  return {
    ok: true,
    reply: `${rows.length} schedule${rows.length === 1 ? "" : "s"}:\n${lines.join("\n")}`,
    data: { items: rows },
  };
}

async function renderKnowledgeSourcesList(p: FastPathParams): Promise<RenderPayload> {
  const rows = await p.db
    .select({
      id: knowledgeSources.id,
      slug: knowledgeSources.slug,
      name: knowledgeSources.name,
      source_type: knowledgeSources.source_type,
    })
    .from(knowledgeSources)
    .where(and(eq(knowledgeSources.tenant_id, p.tenant_id), isNull(knowledgeSources.deleted_at)))
    .orderBy(asc(knowledgeSources.created_at))
    .limit(LIST_LIMIT);
  if (rows.length === 0) {
    return { ok: true, reply: "No knowledge sources yet.", data: { items: [] } };
  }
  const lines = rows.map((r) => `- ${r.slug} (${r.source_type}) — ${r.name}`);
  return {
    ok: true,
    reply: `${rows.length} knowledge source${rows.length === 1 ? "" : "s"}:\n${lines.join("\n")}`,
    data: { items: rows },
  };
}

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
  });
  await updateToolCallOutput(p.db, toolCallId, output);
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
): Promise<RenderPayload> {
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
    const result = await runExecution({
      db: p.db,
      tenant_id: p.tenant_id,
      source: { kind: "saved", workflow_id: wf.id },
      input: input ?? null,
      options: {
        request_source: "chat",
        trace_id: null,
        principal: p.principal,
        execution_mode: "dev",
      },
    });
    const ok = result.status === "succeeded";
    const stepLines = result.steps.map(
      (s) =>
        `- ${s.step_key} (${s.kind}) ${s.status}${s.duration_ms != null ? ` · ${s.duration_ms}ms` : ""}`,
    );
    const warningCount = result.warnings?.length ?? 0;
    const replyParts: string[] = [
      `Ran ${wf.slug} (v${wf.current_version_id ? "" : "?"}): ${result.status}`,
      ...stepLines,
    ];
    if (warningCount > 0) {
      replyParts.push(
        `${warningCount} warning(s): ${Array.from(
          new Set((result.warnings ?? []).map((w) => w.code)),
        )
          .sort()
          .join(", ")}`,
      );
    }
    return {
      ok,
      reply: replyParts.join("\n"),
      data: {
        status: result.status,
        execution_id: result.execution_id,
        workflow_id: wf.id,
        workflow_slug: wf.slug,
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
 * The `run <slug>` branch follows MCP's two-call confirmation gate
 * exactly: first turn emits the pending envelope; second turn (with
 * `__policy_confirmed: true` from the operator's approval) executes.
 */
export async function tryFastPath(p: FastPathParams): Promise<FastPathHit | null> {
  const text = p.user_message.trim();
  if (text.length === 0) return null;

  // List intents — always emit a deterministic answer.
  const listKind = matchListIntent(text);
  if (listKind) {
    const tool = listKind === "knowledge_sources" ? "list_knowledge_sources" : `list_${listKind}`;
    // Mirror the HTTP route's `*:read` gate so a principal who lacks
    // the corresponding permission cannot enumerate via chat what the
    // HTTP layer would deny. The deny is deterministic (no fall-through
    // to the LLM) so the contract is closed at the fast-path boundary.
    {
      const decision = await can(p.db, {
        tenant_id: p.tenant_id,
        principal: p.principal,
        permission: READ_PERMISSION_BY_LIST[listKind],
      });
      if (!decision.allow) {
        const reason = decision.reason ?? "permission_denied";
        await auditPolicyDenied(p, READ_PERMISSION_BY_LIST[listKind], tool, reason);
        const reply = `Permission denied: ${READ_PERMISSION_BY_LIST[listKind]}.`;
        const persisted = await persistFastPathTurn(
          p,
          tool,
          {},
          {
            ok: false,
            denied: true,
            permission: READ_PERMISSION_BY_LIST[listKind],
            reason,
            skipped_llm: true,
          },
          reply,
        );
        recordConversationToolCall({
          category: "tenant_read",
          tool,
          outcome: "denied",
          duration_ms: 0,
        });
        return {
          status: "active",
          events: persisted.events,
          fast_path_tool: tool,
          assistant_text: reply,
        };
      }
    }
    const renderer =
      listKind === "workflows"
        ? renderWorkflowsList
        : listKind === "connectors"
          ? renderConnectorsList
          : listKind === "executions"
            ? renderExecutionsList
            : listKind === "schedules"
              ? renderSchedulesList
              : renderKnowledgeSourcesList;
    const payload = await renderer(p);
    const persisted = await persistFastPathTurn(
      p,
      tool,
      {},
      { ok: payload.ok, ...payload.data, skipped_llm: true },
      payload.reply,
    );
    recordConversationToolCall({
      category: "tenant_read",
      tool,
      outcome: payload.ok ? "ok" : "error",
      duration_ms: 0,
    });
    logger.info({
      module: "conversation",
      action: "conversation.fast_path",
      msg: "fast-path handled list intent",
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      tool,
    });
    return {
      status: "active",
      events: persisted.events,
      fast_path_tool: tool,
      assistant_text: payload.reply,
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
      const gate = await gateTenantToolCall({
        tool: "run_workflow",
        category: "tenant_write",
        args: { workflow: resolved.slug, environment: "dev" },
        meta: undefined,
        principal: p.principal,
        db: p.db,
        via: "fast_path",
      });
      if (gate.kind === "pending") {
        const persisted = await persistFastPathTurn(
          p,
          "run_workflow",
          { workflow: resolved.slug, environment: "dev" },
          {
            ok: false,
            pending: true,
            status: "awaiting_confirmation",
            policy_mode: "confirm_before_execution",
            confirm_required: true,
            target: gate.envelope.target,
            tool_call_id: gate.envelope.tool_call_id,
            resume: gate.envelope.resume,
            skipped_llm: true,
            suggested_command: `/workflows run ${resolved.slug}`,
          },
          `Confirm: run ${resolved.slug} in dev?`,
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
        return {
          status: "awaiting_input",
          events: persisted.events,
          pending_elicitation_id: gate.envelope.tool_call_id,
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
      );
      // `runExecution` already emits its own execution audit row.
      // We previously stamped a CONVERSATION_COMMITTED row here, but
      // that action is reserved for workflow-commit moments (draft →
      // persisted) — see `service/run-turn.ts:145-158`. Dropping the
      // extra row keeps audit semantics aligned across surfaces.
      recordConversationToolCall({
        category: "tenant_write",
        tool: "run_workflow",
        outcome: payload.ok ? "ok" : "error",
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
  // emitted a fast-path `run_workflow` pending envelope, execute the
  // workflow now. Mirrors how MCP re-issues with `__policy_confirmed:
  // true`. We resolve the slug from the prior tool_call input — no
  // hidden state.
  if (AFFIRM_RE.test(text)) {
    const recent = await p.db
      .select({
        id: conversationToolCalls.id,
        tool: conversationToolCalls.tool,
        input: conversationToolCalls.input,
        output: conversationToolCalls.output,
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
    const headOutput = head?.output as { pending?: unknown; tool_call_id?: unknown } | null;
    const headInput = head?.input as { workflow?: unknown } | null;
    if (
      head &&
      headOutput?.pending === true &&
      Date.now() - (head.created_at?.getTime() ?? 0) < AFFIRM_RESUME_WINDOW_MS &&
      typeof headInput?.workflow === "string"
    ) {
      const resolved = await resolveWorkflowByIdOrSlug(p.db, p.tenant_id, headInput.workflow, {
        require_published: true,
      });
      if (resolved?.current_version_id) {
        // Canonical RBAC gate — the resume branch must check the same
        // permission MCP enforces. Without this, an operator whose
        // role changed between the pending request and the approval
        // could bypass `workflow:run` denial.
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
            { workflow: resolved.slug, environment: "dev", __policy_confirmed: true },
            {
              ok: false,
              denied: true,
              permission: "workflow:run",
              reason: rbac.reason,
              error: rbac.error_message,
              skipped_llm: true,
            },
            reply,
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
        // Mirror MCP's APPROVAL_APPROVED via gateTenantToolCall with
        // __policy_confirmed: true so the audit trail records the
        // approval the same way. Capture the result — if a future
        // stricter policy returns `pending` here despite the confirm
        // marker, surface the re-pending envelope rather than running
        // the workflow anyway.
        const resumeGate = await gateTenantToolCall({
          tool: "run_workflow",
          category: "tenant_write",
          args: { workflow: resolved.slug, environment: "dev", __policy_confirmed: true },
          meta: undefined,
          principal: p.principal,
          db: p.db,
          via: "fast_path",
        });
        if (resumeGate.kind !== "proceed") {
          const persisted = await persistFastPathTurn(
            p,
            "run_workflow",
            { workflow: resolved.slug, environment: "dev", __policy_confirmed: true },
            {
              ok: false,
              pending: true,
              status: "awaiting_confirmation",
              policy_mode: "confirm_before_execution",
              confirm_required: true,
              target: resumeGate.envelope.target,
              tool_call_id: resumeGate.envelope.tool_call_id,
              resume: resumeGate.envelope.resume,
              skipped_llm: true,
            },
            `Confirm: run ${resolved.slug} in dev?`,
          );
          recordConversationToolCall({
            category: "tenant_write",
            tool: "run_workflow",
            outcome: "pending",
            duration_ms: 0,
          });
          return {
            status: "awaiting_input",
            events: persisted.events,
            pending_elicitation_id: resumeGate.envelope.tool_call_id,
            fast_path_tool: "run_workflow",
            assistant_text: `Confirm: run ${resolved.slug} in dev?`,
          };
        }
        const payload = await executeRunWorkflow(p, { workflow: resolved }, null);
        const persisted = await persistFastPathTurn(
          p,
          "run_workflow",
          { workflow: resolved.slug, environment: "dev", __policy_confirmed: true },
          { ok: payload.ok, ...payload.data, skipped_llm: true },
          payload.reply,
        );
        recordConversationToolCall({
          category: "tenant_write",
          tool: "run_workflow",
          outcome: payload.ok ? "ok" : "error",
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
  }
  return null;
}
