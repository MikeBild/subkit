// Helper functions for the Workflows → MCP tools capability
// (`registerToolsCapability` in ./tools.ts). Pure code-motion: these are the
// tool-list materialization, missing-input backstop, slug resolution, and
// progress-bridge helpers that back the tools/list and tools/call handlers.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { and, asc, eq, isNull } from "drizzle-orm";

import type { ResolvedPrincipal } from "../../auth/types.ts";
import {
  normalizeWorkflowInput,
  workflowInputRecord,
} from "../../conversations/tools/workflow-input-normalize.ts";
import type { Db } from "../../db/client.ts";
import { executionSteps, workflows } from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import { listWorkflowToolsForTenant } from "../../workflows/catalog.ts";
import { resolveWorkflowInputContract } from "../../workflows/input-schema-synth.ts";
import { resolveWorkflowByIdOrSlug } from "../../workflows/lookup.ts";
import { getWorkflow } from "../../workflows/service.ts";
import type { WorkflowDef } from "../../workflows/types.ts";
import { TOOL_PREFIX } from "./catalog-budget.ts";
import { resolveConversationBoundWorkflowId } from "./run-workflow-async-ack.ts";
import { buildWorkflowToolAnnotations, buildWorkflowToolMeta } from "./tool-meta.ts";

const PROGRESS_POLL_MS = 250;

interface ListToolsParams {
  db: Db;
  principal: ResolvedPrincipal;
  limit?: number;
}

export async function listWorkflowTools({
  db,
  principal,
  limit,
}: ListToolsParams): Promise<Tool[]> {
  const catalog = await listWorkflowToolsForTenant({
    db,
    principal,
    ...(limit !== undefined ? { limit } : {}),
  });
  return catalog.map((entry) => ({
    name: `${TOOL_PREFIX}${entry.slug}`,
    title: entry.name,
    // Frame the tool as an executable action, not a passive description.
    // Without this, a workflow description like "Lists all Test Plan issues…"
    // reads as documentation and the model re-derives the query with
    // call_connector instead of running the saved workflow. The "prefer this
    // over re-deriving" nudge closes that gap.
    description: describeWorkflowTool(entry),
    inputSchema: entry.inputSchema as Tool["inputSchema"],
    ...(entry.outputSchema ? { outputSchema: entry.outputSchema as Tool["outputSchema"] } : {}),
    annotations: buildWorkflowToolAnnotations(entry.effect),
    execution: { taskSupport: "forbidden" as const },
    _meta: buildWorkflowToolMeta(entry.effect),
  }));
}

/**
 * Executable-verb framing for a `wf_<slug>` tool. Runs the saved workflow's
 * stored steps (with its connectors) and returns the result — the canonical
 * way to execute a known task. When the workflow has its own description we
 * append it; otherwise the name carries the intent.
 */
function describeWorkflowTool(entry: { name: string; description: string }): string {
  const summary =
    entry.description && entry.description.trim() !== entry.name.trim()
      ? ` — ${entry.description.trim()}`
      : "";
  return `Run the saved workflow "${entry.name}"${summary}. Executes its stored steps and connectors and returns the result. Prefer this over re-deriving the same query with call_connector.`;
}

// Anti-client-spiral backstop for `run_workflow` over the SESSIONLESS MCP
// direct-call surface. run_workflow dispatched here runs against a synthetic
// stub context (buildMcpStubCtx) with a conversation_id that has NO row: the
// tool's own missing-input gate tries to PAUSE with an `ask_user_form`, but
// the DB-pause insert FK-violates on the non-existent conversation and THROWS
// — the caller then gets an opaque `tool_execute_failed` that never names the
// missing fields. Even if the pause somehow surfaced, its `elicitation_id`
// would be unresolvable (the client called run_workflow directly, not
// conversation_start, so it has no session to answer against). That confusing
// non-terminal dead-end is exactly what spiralled a live ChatGPT session into
// dozens of junk documents.
//
// So we detect the unbound-required-input case UP FRONT — before dispatch —
// and return ONE terminal, actionable `needs_input` envelope that NAMES the
// exact fields inline and states the single next action: re-call run_workflow
// with those inputs supplied. Mirrors the tool's own contract resolution
// (declared input_schema > sample > structural synth via
// resolveWorkflowInputContract) and target precedence (explicit `workflow`
// arg, else the workflow bound to the caller's most-recent conversation) so
// the guard and the tool agree on what "this run needs". Returns null when
// nothing is missing, or when the target/contract can't be resolved (the tool
// then returns its OWN terminal envelope — workflow_not_found /
// workflow_not_persisted — which is already actionable).
export async function buildRunWorkflowNeedsInput(p: {
  db: Db;
  principal: ResolvedPrincipal;
  args: Record<string, unknown>;
}): Promise<{ isError: boolean; content: Array<{ type: "text"; text: string }> } | null> {
  const { db, principal, args } = p;
  let workflowRef =
    typeof args.workflow === "string" && args.workflow.trim().length > 0
      ? args.workflow
      : undefined;
  if (!workflowRef) {
    workflowRef =
      (await resolveConversationBoundWorkflowId({
        db,
        tenant_id: principal.tenant_id,
        owner_id: principal.id,
      })) ?? undefined;
  }
  if (!workflowRef) return null;
  const resolved = await resolveWorkflowByIdOrSlug(db, principal.tenant_id, workflowRef);
  if (!resolved) return null;
  const wf = await getWorkflow(principal.tenant_id, resolved.id, db);
  if (!wf?.definition) return null;
  const contract = resolveWorkflowInputContract(wf.definition as WorkflowDef);
  if (!contract || contract.properties.length === 0) return null;

  const supplied = normalizeWorkflowInput(args.input);
  const suppliedMap = workflowInputRecord(supplied);
  const suppliedIsEmpty =
    supplied === null ||
    supplied === undefined ||
    (typeof supplied === "object" &&
      !Array.isArray(supplied) &&
      Object.keys(suppliedMap).length === 0) ||
    (typeof supplied === "string" && supplied.trim().length === 0);
  const missing = contract.required.filter((k) => {
    const v = suppliedMap[k];
    return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
  });
  // Fully satisfied — let the real dispatch run.
  if (!suppliedIsEmpty && missing.length === 0) return null;

  const missingNames = missing.length > 0 ? missing : contract.required;
  const schemaProps =
    contract.schema.properties && typeof contract.schema.properties === "object"
      ? (contract.schema.properties as Record<string, unknown>)
      : {};
  const fields = contract.properties.map((n) => {
    const prop =
      schemaProps[n] && typeof schemaProps[n] === "object"
        ? (schemaProps[n] as Record<string, unknown>)
        : {};
    return {
      name: n,
      required: contract.required.includes(n),
      ...(typeof prop.type === "string" ? { type: prop.type } : {}),
      ...(typeof prop.description === "string" ? { description: prop.description } : {}),
    };
  });
  const one = missingNames.length === 1;
  const fieldList = missingNames.map((n) => `\`${n}\``).join(", ");
  const example = `run_workflow({ workflow: "${resolved.slug}", input: { ${missingNames
    .map((n) => `${n}: … `)
    .join(", ")}} })`;
  const message = `Workflow "${resolved.slug}" cannot run yet: required ${one ? "input" : "inputs"} ${fieldList} ${
    one ? "is" : "are"
  } missing. This is the SINGLE next step — re-call run_workflow with ${
    one ? "that value" : "those values"
  } supplied in \`input\`, e.g. ${example}. Do NOT retry without the input, and take no other action until it is provided.`;
  return {
    isError: false,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          status: "needs_input",
          error_code: "missing_input",
          tool: "run_workflow",
          workflow: resolved.slug,
          message,
          missing_fields: missingNames,
          required_fields: contract.required,
          fields,
        }),
      },
    ],
  };
}

export async function resolveWorkflowBySlug(
  db: Db,
  tenant_id: string,
  slug: string,
): Promise<{ id: string } | null> {
  const rows = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        eq(workflows.tenant_id, tenant_id),
        eq(workflows.slug, slug),
        isNull(workflows.deleted_at),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export interface ProgressNotifier {
  send: (progress: number, total: number, message: string) => Promise<void>;
}

export function startProgressBridge(
  db: Db,
  tenant_id: string,
  execution_id: string,
  totalStepsHint: number,
  notifier: ProgressNotifier,
): { stop: () => void } {
  let stopped = false;
  let seen = 0;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const rows = await db
        .select({
          id: executionSteps.id,
          step_key: executionSteps.step_key,
          status: executionSteps.status,
        })
        .from(executionSteps)
        .where(
          and(
            eq(executionSteps.tenant_id, tenant_id),
            eq(executionSteps.execution_id, execution_id),
          ),
        )
        .orderBy(asc(executionSteps.started_at));
      if (rows.length > seen) {
        for (let i = seen; i < rows.length; i++) {
          const row = rows[i];
          if (!row) continue;
          const progress = (i + 1) / Math.max(totalStepsHint, rows.length);
          await notifier.send(Math.min(progress, 0.999), 1, row.step_key).catch(() => {});
        }
        seen = rows.length;
      }
    } catch (err) {
      // Bridge is best-effort, but log so a recurring failure is
      // visible. A bursty progress-notifier outage looks otherwise
      // identical to "no work to report" from the operator's view.
      logger.debug({
        module: "mcp",
        action: "tool_progress.poll_failed",
        msg: "MCP tool progress poll failed; bridge will retry on next tick",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (!stopped) {
      setTimeout(() => {
        void tick();
      }, PROGRESS_POLL_MS).unref?.();
    }
  };
  setTimeout(() => {
    void tick();
  }, PROGRESS_POLL_MS).unref?.();
  return {
    stop: () => {
      stopped = true;
    },
  };
}
