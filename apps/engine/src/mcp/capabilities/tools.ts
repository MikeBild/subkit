// Workflows → MCP tools.
//
// - `tools/list` is implemented by loading the tenant's workflows and
//   materializing a tool per workflow. The tool name is `wf.<slug>`,
//   description is the workflow name, and inputSchema is taken straight
//   from the workflow DAG's `input_schema` field (which users author as
//   raw JSON schema). When no schema is declared we default to an empty
//   object schema.
//
// - `tools/call` resolves the `wf.<slug>` tool name back to a workflow id,
//   runs the execution inline via the P3 `runExecution` entry point (so
//   tests + tool calls don't need a live pg-boss), and returns the final
//   output. Results larger than the 20k char cap are offloaded to
//   `execution_fixtures` via `maybeOffload`.
//
// - While the execution is running, a poller watches `execution_steps`
//   for new rows and emits `notifications/progress` frames keyed by the
//   caller's `progressToken`. The poller ticks every ~250 ms and stops
//   when the execution finishes.

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type ServerNotification,
  type ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { and, asc, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { getConfig } from "../../config/loader.ts";
import type { Db } from "../../db/client.ts";
import { executions, workflows, workflowVersions } from "../../db/schema/index.ts";
import { cancel } from "../../execution/abort.ts";
import { runExecution } from "../../execution/engine.ts";
import { maybeOffload } from "../../execution/offload.ts";
import { logger } from "../../logging/logger.ts";
import { globalEmitter } from "../../pubsub/emitter.ts";
import type { EventEnvelope } from "../../pubsub/types.ts";
import { getUnifiedRegistry } from "../../tools/index.ts";
import type { ToolInvocation } from "../../tools/types.ts";
import { gateWorkflowRunRbac } from "../../workflows/rbac.ts";
import { WorkflowDefSchema } from "../../workflows/types.ts";
import { callToolViaDispatcher } from "../adapter.ts";
import { createElicitationBridge } from "../elicitation/bridge.ts";
import { buildElicitConfirmResolver } from "../elicitation/confirm-resolver.ts";
import { toMcpErrorText } from "../error-adapter.ts";
import { MCP_CORE_TOOL_NAMES, modeFlags, resolveMcpMode } from "../mode-resolver.ts";
import { MCP_OFFLOAD_CHAR_CAP } from "../types.ts";
import {
  CONFIRM_TOOL_CALL_NAME,
  DEFAULT_PALETTE_LIMIT,
  fitCatalogToBudget,
  SCHEMA_TOKEN_BUDGET,
  TOOL_PREFIX,
} from "./catalog-budget.ts";
import { CONVERSATION_TOOL_PREFIX, handleConversationTool } from "./conversations.ts";
import { buildResultEnvelope } from "./held-preview.ts";
import { raceInlineRun } from "./inline-timeout.ts";
import { paginate } from "./pagination.ts";
import {
  findBackgroundExecutionId,
  resolveConversationBoundWorkflowId,
} from "./run-workflow-async-ack.ts";
import {
  buildRunWorkflowNeedsInput,
  listWorkflowTools,
  type ProgressNotifier,
  resolveWorkflowBySlug,
  startProgressBridge,
} from "./tools-helpers.ts";

// Upper bound on how long a `wf_<slug>` run blocks the tools/call response, so
// a slow run can't blow past a client's request timeout (strict clients abort
// tool calls around ~60s). Past this window we stop blocking and hand back a
// polling handle (execution_id → get_execution) while the run finishes in the
// background. Fast runs (the common case) resolve inside this and return
// inline unchanged. Applies to every client/transport.
const WF_INLINE_TIMEOUT_MS = 50_000;
// Bound how long a tools/call dispatch may block the response before we hand
// back a clear "engine busy" error instead of letting the client hang to its
// own (much longer) request timeout. Sits above the common-case latency and
// below strict clients' ~60s abort.
const TOOLS_CALL_DEADLINE_MS = 30_000;
// Coalesce `notifications/tools/list_changed` bursts: a bulk import that
// emits many `workflow.lifecycle` events in quick succession yields a
// single client-facing ping, not a storm. Trailing-window from the first
// event of a burst.
const TOOL_LIST_CHANGED_DEBOUNCE_MS = 250;

export interface RegisterToolsParams {
  server: Server;
  db: Db;
  principal: ResolvedPrincipal;
  transport: "http" | "stdio";
}

export function registerToolsCapability(p: RegisterToolsParams): void {
  const { server, db, principal } = p;

  server.registerCapabilities({ tools: { listChanged: true } });

  // Tool-list freshness. The `wf_<slug>` catalog is DB-driven (see
  // `listWorkflowTools` → `catalog.ts`), so any workflow
  // create/update/delete/restore/metadata change alters the tool list
  // mid-session. We subscribe to the same `workflow.lifecycle` pub/sub
  // channel `resources.ts` uses and push `notifications/tools/list_changed`
  // so spec-compliant clients re-fetch `tools/list` across the next turn
  // without a manual `/mcp` reconnect.
  //
  // Tenant isolation: cross-tenant events drop before anything else
  // (same guard as `forwardIfSubscribed`). No RBAC re-check is needed —
  // the notification carries no payload (no workflow id), and the
  // follow-up `tools/list` it triggers is itself principal-scoped and
  // RBAC-filtered in `catalog.ts`. Delivery is best-effort: a failed
  // `sendToolListChanged` logs once at `warn` and is swallowed, matching
  // the resources-channel discipline (clients poll on critical paths).
  let listChangedTimer: ReturnType<typeof setTimeout> | undefined;
  const offWorkflowLifecycle = globalEmitter.on(
    "workflow.lifecycle",
    (event: EventEnvelope<unknown>) => {
      if (event.tenant_id !== principal.tenant_id) return;
      // Leading-edge schedule: the first event of a burst arms a single
      // trailing fire; later events inside the window are absorbed by it.
      if (listChangedTimer) return;
      listChangedTimer = setTimeout(() => {
        listChangedTimer = undefined;
        void server.sendToolListChanged().catch((err: unknown) => {
          logger.warn({
            module: "mcp",
            action: "mcp.tools.list_changed.failed",
            msg: "failed to send mcp tools list_changed",
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }, TOOL_LIST_CHANGED_DEBOUNCE_MS);
      listChangedTimer.unref?.();
    },
  );
  // Tear down the listener + pending timer when the session closes so we
  // don't leak handlers across reconnects. Chain any prior `onclose`
  // (e.g. the resources capability sets one too).
  const priorOnClose = server.onclose;
  server.onclose = (): void => {
    offWorkflowLifecycle();
    if (listChangedTimer) {
      clearTimeout(listChangedTimer);
      listChangedTimer = undefined;
    }
    if (typeof priorOnClose === "function") {
      try {
        priorOnClose();
      } catch {
        // ignore
      }
    }
  };

  // The env var below forces a strictly read-only MCP deployment —
  // overriding mode-based visibility.
  let readOnly = false;
  try {
    readOnly = getConfig().mcp.read_only;
  } catch {
    /* loader not initialised */
  }

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    // The catalog is assembled per mcp mode, then trimmed to fit the strict
    // tools/list token budget (fitCatalogToBudget) so strict clients never
    // silently drop tools. Sources per tier:
    //   - listWorkflowTools     — wf_<slug> per-workflow tools (Top-N palette).
    //   - listToolsViaRegistry  — unified registry: static (authenticate,
    //                             list_recipes, self_healing.scan in admin)
    //                             plus every visible conversation tool under
    //                             its bare name.
    //   - listConversationTools — MCP-only conversation.* session tools.
    //   - CONFIRM_TOOL_CALL_TOOL — always appended as the confirm fallback.
    // The trimmed long tail stays reachable via find_workflow /
    // run_workflow(slug) (search-first) — nothing becomes unreachable.
    const initialMode = resolveMcpMode(principal);
    // The confirm responder is always surfaced (see assembleTier) — a client
    // that advertises elicitation simply never calls it. We still read the
    // client's elicitation capability, but only as a logged signal: it tells
    // us which confirm path a given call is expected to take (in-band
    // elicitation vs. the model-driven confirm_tool_call fallback).
    const clientCaps = server.getClientCapabilities();
    const elicitationCapable = clientCaps?.elicitation != null;
    // Pin which confirm path a given client gets, so we can prove from logs
    // whether a real in-band human gate (elicitation) is reachable or the
    // model-driven confirm_tool_call fallback is in play.
    logger.info({
      module: "mcp",
      action: "mcp.client.capabilities",
      msg: "client capabilities at tools/list",
      elicitation: elicitationCapable,
      sampling: clientCaps?.sampling != null,
      roots: clientCaps?.roots != null,
      tasks: clientCaps?.tasks != null,
      confirm_path: elicitationCapable ? "elicitation" : "confirm_tool_call",
      principal_id: principal.id,
      tenant_id: principal.tenant_id,
    });
    // Fetch the full wf_ palette once (mode-independent); the cascade slices it.
    const fullPalette = await listWorkflowTools({
      db,
      principal,
      limit: DEFAULT_PALETTE_LIMIT,
    });
    const fit = fitCatalogToBudget({
      principal,
      readOnly,
      initialMode,
      fullPalette,
    });
    // Defense-in-depth: the search-first floor must survive the trim. The
    // leanest tier preserves it by construction (product allow-list +
    // static + appended confirm), but assert it so a future regression is
    // loud rather than silent. confirm_tool_call is an unconditional floor
    // member for every client (the guaranteed confirm fallback).
    const presentNames = new Set(fit.tools.map((t) => t.name));
    const missingCore = [...MCP_CORE_TOOL_NAMES].filter((coreName) => !presentNames.has(coreName));
    if (missingCore.length > 0) {
      logger.warn({
        module: "mcp",
        action: "mcp.catalog.floor_violation",
        msg: "search-first core tool(s) missing from the fitted catalog",
        missing: missingCore,
        mode: fit.mode,
        principal_id: principal.id,
        tenant_id: principal.tenant_id,
      });
    }
    // A rich authoring/admin catalog can legitimately stay over budget — we
    // never drop named tools, capable clients handle it, and the essentials are
    // ordered first so a strict client that truncates keeps what matters. So
    // over-budget is informational (in the fitted event), not a warning; the
    // only alarm is a floor violation (above).
    logger.info({
      module: "mcp",
      action: "mcp.catalog.fitted",
      msg: "tools/list catalog fitted to budget",
      tool_count: fit.tools.length,
      est_tokens_before: fit.estTokensBefore,
      est_tokens_after: fit.estTokensAfter,
      mode: fit.mode,
      palette_n: fit.paletteLimit,
      compressed: fit.compressed,
      over_budget: fit.estTokensAfter > SCHEMA_TOKEN_BUDGET,
      principal_id: principal.id,
      tenant_id: principal.tenant_id,
    });
    const page = paginate("tools/list", fit.tools, request.params?.cursor);
    return { tools: page.page, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  });

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => {
      const name = request.params.name;
      const args = request.params.arguments ?? {};
      const progressToken = request.params._meta?.progressToken;
      const envMeta = (request.params._meta as { environment?: unknown } | undefined)?.environment;
      let execution_mode: "dev" | "prod" = "dev";
      if (typeof envMeta === "string") {
        const normalized = envMeta.toLowerCase();
        if (normalized === "dev" || normalized === "prod") {
          execution_mode = normalized;
        }
      }
      // a `wf_<slug>` run holds write-classified steps (sends, writes)
      // by default; they resolve but never dispatch, so the authoring agent
      // verifying a workflow cannot fire a real send. A live run is the
      // deliberate `_meta.execute_writes:true` opt-in (set only after the
      // user confirms a real run). The scheduler/HTTP run paths don't route
      // through here, so production runs still send.
      const executeWrites =
        (request.params._meta as { execute_writes?: unknown } | undefined)?.execute_writes === true;
      const started = Date.now();
      logger.info({
        module: "mcp",
        action: "mcp.tool.call",
        msg: "mcp tool call received",
        tool: name,
        principal_id: principal.id,
        tenant_id: principal.tenant_id,
        progress_token: progressToken ?? null,
      });

      // Every named MCP tool (authenticate, list_recipes,
      // self_healing.scan + the four conversation duplicates) and every
      // bare-name conversation tool routes through the unified dispatcher
      // in apps/engine/src/tools/. wf.<slug> and the conversation.* prefix
      // RPCs remain on the legacy path below because they are
      // surface-specific operational concerns, not LLM tool palette items.
      const mcpModeForCall = resolveMcpMode(principal);
      const readOnlyForCall = !modeFlags(mcpModeForCall, readOnly).showTenantWrites;

      // Confirm responder (fallback for elicitation-incapable clients):
      // re-dispatch the named tool with the confirm marker set. The gate
      // already ran on the first call (APPROVAL_REQUESTED); this approves
      // it. Handled before the registry probe because the responder is not
      // a registry tool.
      if (name === CONFIRM_TOOL_CALL_NAME) {
        const targetTool = typeof args.tool === "string" ? args.tool : "";
        const targetArgs =
          args.arguments && typeof args.arguments === "object"
            ? (args.arguments as Record<string, unknown>)
            : {};
        const confirmId = typeof args.confirm_id === "string" ? args.confirm_id : undefined;
        if (!targetTool || !confirmId) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error_code: "invalid_args",
                  message: "confirm_tool_call requires `tool` and `confirm_id`.",
                }),
              },
            ],
          };
        }
        const confirmedInvocation: ToolInvocation = {
          surface: "mcp",
          name: targetTool,
          args: targetArgs,
          meta: { sk_confirm: true, sk_confirm_id: confirmId },
        };
        const response = await callToolViaDispatcher({
          db,
          principal,
          mcpMode: mcpModeForCall,
          readOnly: readOnlyForCall,
          invocation: confirmedInvocation,
        });
        logger.info({
          module: "mcp",
          action: "mcp.tool.result",
          msg: "mcp confirm_tool_call resolved",
          tool: targetTool,
          duration_ms: Date.now() - started,
          is_error: response.isError,
        });
        return response;
      }

      const probeEntry = getUnifiedRegistry().get(name, {
        surface: "mcp",
        mcpMode: mcpModeForCall,
        readOnly: readOnlyForCall,
      });
      if (probeEntry) {
        // Anti-client-spiral backstop: run_workflow over the sessionless MCP
        // surface cannot pause for missing input (no live conversation to
        // elicit against — the pause throws an opaque tool_execute_failed).
        // Return ONE terminal `needs_input` naming the fields BEFORE dispatch.
        if (name === "run_workflow") {
          const needsInput = await buildRunWorkflowNeedsInput({
            db,
            principal,
            args: args as Record<string, unknown>,
          });
          if (needsInput) {
            logger.info({
              module: "mcp",
              action: "mcp.tool.needs_input",
              msg: "run_workflow over MCP missing required input — returned terminal needs_input",
              tool: name,
              duration_ms: Date.now() - started,
              principal_id: principal.id,
              tenant_id: principal.tenant_id,
            });
            return needsInput;
          }
        }
        const callMeta = request.params._meta as Record<string, unknown> | undefined;
        const invocation: ToolInvocation = {
          surface: "mcp",
          name,
          args: args as Record<string, unknown>,
          ...(callMeta ? { meta: callMeta } : {}),
        };
        // In-band human-in-the-loop: when the client advertises elicitation
        // (and is not already resolving an out-of-band confirm token), attach
        // a resolver that prompts the operator via `elicitation/create`. It is
        // a best-effort optimization over the always-present confirm_tool_call
        // responder — see buildElicitConfirmResolver for the full rationale.
        const carriesInbandConfirm =
          (callMeta as { sk_confirm?: unknown } | undefined)?.sk_confirm === true ||
          typeof (callMeta as { sk_confirm_id?: unknown } | undefined)?.sk_confirm_id === "string";
        const bridge = createElicitationBridge(server, extra);
        const confirmResolver = buildElicitConfirmResolver({
          bridge,
          carriesInbandConfirm,
          toolName: name,
          principalId: principal.id,
          tenantId: principal.tenant_id,
        });
        // Bound the dispatch so a stalled call (e.g. event-loop pressure or a
        // slow downstream) returns a clear "engine busy" error instead of
        // hanging until the client's own (much longer) request timeout. The
        // dispatch keeps running in the background — we just stop blocking.
        const raced = await raceInlineRun(
          callToolViaDispatcher({
            db,
            principal,
            mcpMode: mcpModeForCall,
            readOnly: readOnlyForCall,
            invocation,
            ...(confirmResolver ? { confirmResolver } : {}),
          }),
          TOOLS_CALL_DEADLINE_MS,
        );
        if (raced.timedOut) {
          // `run_workflow` kicks off a real execution that keeps running in
          // the background past the inline deadline. Returning bare
          // `engine_busy` orphaned that run, so a client retry RE-RAN the
          // workflow (duplicate execution). Instead hand back the
          // execution_id poll handle — the same async-ack the `wf_<slug>`
          // path returns when it outlives its inline window — so the client
          // polls `get_execution` rather than re-running. The dispatch
          // promise is intentionally left running; we only stop blocking on
          // it.
          if (name === "run_workflow") {
            // Mirror run_workflow's own target precedence: explicit `workflow`
            // arg first, else the workflow most recently bound to the caller's
            // conversation. Without the bound-target fallback a conversation-
            // bound run with no `workflow` arg resolved to null here and
            // orphaned the live run into `engine_busy`.
            let workflowRef = typeof args.workflow === "string" ? args.workflow : undefined;
            if (!workflowRef) {
              workflowRef =
                (await resolveConversationBoundWorkflowId({
                  db,
                  tenant_id: principal.tenant_id,
                  owner_id: principal.id,
                })) ?? undefined;
            }
            const execId = await findBackgroundExecutionId({
              db,
              tenant_id: principal.tenant_id,
              workflowRef,
              since: started,
            });
            if (execId) {
              logger.info({
                module: "mcp",
                action: "mcp.tool.result",
                msg: "run_workflow exceeded inline deadline — returned polling handle",
                tool: name,
                duration_ms: Date.now() - started,
                execution_id: execId,
                principal_id: principal.id,
                tenant_id: principal.tenant_id,
              });
              return {
                isError: false,
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({
                      status: "running",
                      execution_id: execId,
                      message: `Workflow run is still executing after ${Math.round(
                        TOOLS_CALL_DEADLINE_MS / 1000,
                      )}s. Poll get_execution with this execution_id for the result — do NOT re-run, it is already in progress.`,
                      poll_with: "get_execution",
                    }),
                  },
                ],
                _meta: { subkit: { execution: { id: execId, status: "running" } } },
              };
            }
          }
          logger.warn({
            module: "mcp",
            action: "mcp.tool.deadline_exceeded",
            msg: "mcp tool call exceeded the inline deadline; returned engine-busy",
            tool: name,
            deadline_ms: TOOLS_CALL_DEADLINE_MS,
            duration_ms: Date.now() - started,
            principal_id: principal.id,
            tenant_id: principal.tenant_id,
          });
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error_code: "engine_busy",
                  message: `Tool "${name}" did not respond within ${Math.round(
                    TOOLS_CALL_DEADLINE_MS / 1000,
                  )}s (engine busy). Please retry.`,
                }),
              },
            ],
          };
        }
        const response = raced.result;
        logger.info({
          module: "mcp",
          action: "mcp.tool.result",
          msg: "mcp tool call completed via unified dispatcher",
          tool: name,
          duration_ms: Date.now() - started,
          is_error: response.isError,
        });
        return response;
      }

      if (name.startsWith(CONVERSATION_TOOL_PREFIX)) {
        // Accept `_meta.sk_permission_mode` on MCP calls so the sk REPL
        // and external MCP clients can drive the same auto / ask / plan
        // loop the HTTP surface exposes. Unknown values are ignored and
        // the conversation falls back to the tenant default.
        const permissionModeMeta = (
          request.params._meta as { sk_permission_mode?: unknown } | undefined
        )?.sk_permission_mode;
        const permissionMode =
          permissionModeMeta === "auto" ||
          permissionModeMeta === "ask" ||
          permissionModeMeta === "plan" ||
          permissionModeMeta === "yolo"
            ? permissionModeMeta
            : undefined;
        // Accept `_meta.sk_playground` to start a conversation as a
        // scratch/sandbox surface. Additive + out-of-band, so the
        // conversation_start INPUT schema stays untouched (no OpenAPI drift),
        // exactly like `sk_permission_mode` above.
        const playground =
          (request.params._meta as { sk_playground?: unknown } | undefined)?.sk_playground === true;
        // MCP async Tasks (SEP-1686). A conversation turn runs in the
        // background `conversation.run-turn` worker — the handler never
        // runs the model loop inline. `request.params.task` is set by
        // the SDK only when the client advertised the `tasks`
        // capability; its presence (cross-checked with the negotiated
        // client capability) means the client can consume a
        // `CreateTaskResult`. The conversation loop therefore takes the
        // DB-pause elicitation path, NOT the live `ElicitationBridge` —
        // a backgrounded turn has no live session.
        const taskParamPresent = request.params.task !== undefined;
        const clientTasksCapable = server.getClientCapabilities()?.tasks !== undefined;
        const taskAugmented = taskParamPresent && clientTasksCapable;
        const result = await handleConversationTool({
          db,
          principal,
          name,
          args: args as Record<string, unknown>,
          ...(permissionMode ? { permission_mode: permissionMode } : {}),
          ...(playground ? { playground } : {}),
          ...(taskAugmented ? { taskAugmented } : {}),
        });
        logger.info({
          module: "mcp",
          action: "mcp.tool.result",
          msg: "mcp conversation tool call completed",
          tool: name,
          duration_ms: Date.now() - started,
          is_error: result.isError,
          task_augmented: taskAugmented,
        });
        // A Tasks-capable, turn-driving call returns a CreateTaskResult
        // verbatim; everything else returns the plain CallToolResult.
        if (result.createTaskResult) {
          return result.createTaskResult;
        }
        return {
          isError: result.isError,
          content: result.content.map((c) => ({ type: "text" as const, text: c.text })),
        };
      }

      if (!name.startsWith(TOOL_PREFIX)) {
        // Terminal, actionable cannot_help (anti-client-spiral). A bare
        // "unknown tool: X" string is an ambiguous dead-end — a strict client
        // that reached here (a hallucinated name, or a gated tool absent from
        // its palette, e.g. `run_workflow` withheld in a read-only mode) has
        // no next step and can loop/spiral. Name the single recovery path.
        logger.warn({
          module: "mcp",
          action: "mcp.tool.unknown",
          msg: "tools/call for a tool not in this surface's catalog — returned terminal cannot_help",
          tool: name,
          principal_id: principal.id,
          tenant_id: principal.tenant_id,
        });
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "cannot_help",
                error_code: "unknown_tool",
                tool: name,
                message: `No tool named "${name}" is available on this surface. To run a saved workflow, call find_workflow to locate it, then run_workflow(workflow: "<slug>"). To build or edit a workflow or connector, call conversation_start. Do NOT retry "${name}" — it does not exist here.`,
                next_best_actions: ["find_workflow", "run_workflow", "conversation_start"],
              }),
            },
          ],
        };
      }
      const slug = name.slice(TOOL_PREFIX.length);
      const wf = await resolveWorkflowBySlug(db, principal.tenant_id, slug);
      if (!wf) {
        // Terminal, actionable envelope — not a bare "workflow not found"
        // string. The slug may have been renamed/deleted (the tool list
        // changed mid-session); tell the client to re-discover the current
        // slug rather than guess another one and loop.
        logger.info({
          module: "mcp",
          action: "mcp.tool.workflow_not_found",
          msg: "wf_<slug> tools/call did not resolve to a workflow — returned terminal cannot_help",
          tool: name,
          slug,
          principal_id: principal.id,
          tenant_id: principal.tenant_id,
        });
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "cannot_help",
                error_code: "workflow_not_found",
                workflow: slug,
                message: `No saved workflow matches "${slug}" — it may have been renamed or deleted since the tool list was fetched. Call find_workflow or list_workflows to get the current slug, then retry. Do NOT guess another slug.`,
                next_best_actions: ["find_workflow", "list_workflows"],
              }),
            },
          ],
        };
      }

      // Canonical RBAC gate. See `workflows/rbac.ts` —
      // the chat fast-path, synthetic palette, and fallback
      // `run_workflow` tool call the same helper so the four
      // execution surfaces cannot drift on permission semantics or
      // audit metadata.
      const rbac = await gateWorkflowRunRbac({
        db,
        principal,
        workflow_id: wf.id,
        workflow_slug: slug,
        request_source: "mcp",
        tool: name,
      });
      if (!rbac.allow) {
        const err = new Error(rbac.error_message) as Error & { code?: number };
        err.code = -32001;
        throw err;
      }

      // Work out how many steps the current version has for the
      // progress bridge's total estimate. The same DAG parse tells us
      // whether the workflow declares an `output_schema` — when it does,
      // tools/list advertised an `outputSchema`, so tools/call MUST return
      // a conforming `structuredContent` (MCP 2025-11-25 tools §Output Schema).
      let totalSteps = 1;
      let outputSchemaDeclared = false;
      try {
        const wfRows = await db
          .select({ current_version_id: workflows.current_version_id })
          .from(workflows)
          .where(and(eq(workflows.tenant_id, principal.tenant_id), eq(workflows.id, wf.id)))
          .limit(1);
        const vId = wfRows[0]?.current_version_id ?? null;
        if (vId) {
          const vRows = await db
            .select({ dag: workflowVersions.dag })
            .from(workflowVersions)
            .where(
              and(
                eq(workflowVersions.tenant_id, principal.tenant_id),
                eq(workflowVersions.id, vId),
              ),
            )
            .limit(1);
          const parsed = vRows[0]?.dag ? WorkflowDefSchema.safeParse(vRows[0].dag) : null;
          if (parsed?.success) {
            totalSteps = parsed.data.steps.length;
            outputSchemaDeclared = parsed.data.output_schema != null;
          }
        }
      } catch {
        // best effort
      }

      // Wire up MCP's cancellation signal into the execution abort.
      const abortController = new AbortController();
      const onSignalAbort = (): void => {
        abortController.abort("mcp_cancelled");
      };
      if (extra.signal.aborted) onSignalAbort();
      else extra.signal.addEventListener("abort", onSignalAbort, { once: true });

      // Kick off the execution. We store the returned execution id as soon
      // as possible so the progress bridge can find the steps.
      const state: {
        bridge: { stop: () => void } | null;
        executionId: string | null;
      } = { bridge: null, executionId: null };
      const notifier: ProgressNotifier = {
        send: async (progress, total, message) => {
          if (progressToken === undefined || progressToken === null) return;
          await extra.sendNotification({
            method: "notifications/progress",
            params: {
              progressToken,
              progress,
              total,
              message,
            },
          });
        },
      };

      // We use runExecution directly so the test harness + MCP stdio mode
      // don't need a live pg-boss.
      const runPromise = runExecution({
        db,
        tenant_id: principal.tenant_id,
        source: { kind: "saved", workflow_id: wf.id },
        input: args,
        options: {
          request_source: "mcp",
          signal: abortController.signal,
          trace_id: null,
          principal,
          execution_mode,
          ...(executeWrites ? {} : { hold_writes: true }),
        },
      });

      // Poll the executions table briefly to pick up the id (createExecution
      // is called synchronously inside runExecution's first tick, so we kick
      // off the bridge on the next microtask).
      void Promise.resolve().then(async () => {
        // Small delay so the executions row lands before the first poll.
        setTimeout(async () => {
          try {
            const rows = await db
              .select({ id: executions.id })
              .from(executions)
              .where(
                and(
                  eq(executions.tenant_id, principal.tenant_id),
                  eq(executions.workflow_id, wf.id),
                ),
              )
              .orderBy(asc(executions.created_at));
            // Most recent id for this workflow.
            const latest = rows[rows.length - 1];
            if (latest) {
              state.executionId = latest.id;
              if (progressToken !== undefined && progressToken !== null) {
                state.bridge = startProgressBridge(
                  db,
                  principal.tenant_id,
                  latest.id,
                  totalSteps,
                  notifier,
                );
              }
            }
          } catch {
            // ignore
          }
        }, 25).unref?.();
      });

      try {
        // Bound the inline wait so a slow run doesn't blow past the client's
        // request timeout. On timeout, detach the cancel wiring (so completing
        // the response doesn't abort the run), let it finish in the
        // background, and hand back a polling handle.
        const outcome = await raceInlineRun(runPromise, WF_INLINE_TIMEOUT_MS);
        if (outcome.timedOut) {
          // Still running — stop blocking the client but keep the run alive.
          extra.signal.removeEventListener("abort", onSignalAbort);
          runPromise.then(() => state.bridge?.stop()).catch(() => state.bridge?.stop());
          const execId = state.executionId;
          if (!execId) {
            // We never captured the execution id (the id-poll had not landed
            // before the inline window closed). Do NOT hand back a
            // "poll get_execution with <null>" handle the client can loop on —
            // that is the confusing non-terminal state. The run IS alive in
            // the background; tell the client to look it up via
            // list_executions rather than re-run (which would double-fire).
            logger.warn({
              module: "mcp",
              action: "mcp.tool.result",
              msg: "mcp wf run exceeded inline window before its execution id was captured",
              tool: name,
              duration_ms: Date.now() - started,
              execution_id: null,
            });
            return {
              isError: false,
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    status: "running",
                    execution_id: null,
                    message: `Workflow ${slug} is still running after ${Math.round(
                      WF_INLINE_TIMEOUT_MS / 1000,
                    )}s, but its execution id was not captured in time. It is ALREADY in progress — do NOT re-run it. Call list_executions to find the running execution, then poll get_execution for the result.`,
                    poll_with: "list_executions",
                  }),
                },
              ],
            };
          }
          logger.info({
            module: "mcp",
            action: "mcp.tool.result",
            msg: "mcp wf run exceeded inline window — returned polling handle",
            tool: name,
            duration_ms: Date.now() - started,
            execution_id: execId,
          });
          return {
            isError: false,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "running",
                  execution_id: execId,
                  message: `Workflow ${slug} is still running after ${Math.round(
                    WF_INLINE_TIMEOUT_MS / 1000,
                  )}s. Poll get_execution with this execution_id for the result.`,
                  poll_with: "get_execution",
                }),
              },
            ],
            _meta: { subkit: { execution: { id: execId, status: "running" } } },
          };
        }
        const result = outcome.result;
        state.bridge?.stop();
        // Final progress frame @ 1.0.
        if (progressToken !== undefined && progressToken !== null) {
          await notifier.send(1, 1, "completed").catch(() => {});
        }
        // When a run produced non-fatal warnings (e.g. jsonata
        // `unresolved_identifier`), wrap the output so the MCP client sees
        // them alongside the payload. On top of that, a held-writes preview
        // (the default wf_* run) gets a first-class `preview` envelope +
        // `_meta` flag so the model cannot mistake it for a real write —
        // the "gemeldet ≠ geschrieben" no-op. See held-preview.ts.
        const hasWarnings = (result.warnings?.length ?? 0) > 0;
        const envelope = buildResultEnvelope(result);
        const { rawBody, previewMeta } = envelope;
        // Offload if oversize. Warnings travel with the envelope.
        const serialized = JSON.stringify(rawBody);
        if (serialized.length > MCP_OFFLOAD_CHAR_CAP) {
          const off = await maybeOffload(db, {
            tenant_id: principal.tenant_id,
            execution_id: result.execution_id,
            step_id: null,
            result: result.output,
          });
          // MCP `resource_link` content block. The previous
          // text-encoded JSON envelope forced clients to parse a string
          // field to discover the fixture URI; LLM agents rarely follow
          // such pointers without explicit instruction.
          // `resource_link` is the native protocol affordance: compliant
          // clients can auto-fetch, surface to the user, or expose the
          // URI as a follow-up call. Pairs with the `fixture://` reader
          // in apps/engine/src/mcp/capabilities/resources.ts.
          const summaryLines: string[] = [
            `Execution ${result.execution_id} ${result.status}; result is ${off.size_bytes} bytes (offloaded — inline cap is ${MCP_OFFLOAD_CHAR_CAP} bytes).`,
          ];
          if (envelope.isHeldPreview) {
            summaryLines.push(`⚠ PREVIEW — no writes performed. ${envelope.heldMessage}`);
          }
          if (off.preview) summaryLines.push(`Preview: ${off.preview}`);
          if (hasWarnings) {
            summaryLines.push(`Warnings: ${JSON.stringify(result.warnings)}`);
          }
          const storageUri = off.storage_uri;
          if (!storageUri) {
            // Shouldn't happen: maybeOffload always returns a uri when
            // size > STEP_RESULT_DB_BYTES (10 KB), and we are here
            // because serialized > MCP_OFFLOAD_CHAR_CAP (20 KB). Belt
            // and braces — if it ever does, fall back to inline text
            // so the client still gets the payload.
            return {
              isError: result.status !== "succeeded",
              content: [{ type: "text" as const, text: serialized }],
              ...previewMeta,
            };
          }
          const resourceLink = {
            type: "resource_link" as const,
            uri: storageUri,
            name: `${name} result`,
            description: `Full ${off.size_bytes}-byte result of ${name} (execution ${result.execution_id})`,
            mimeType: "application/json",
            size: off.size_bytes,
          };
          const bytes = summaryLines.join("\n\n").length + storageUri.length;
          logger.info({
            module: "mcp",
            action: "mcp.tool.result",
            msg: "mcp tool call offloaded",
            tool: name,
            duration_ms: Date.now() - started,
            bytes,
            execution_id: result.execution_id,
            warnings_count: result.warnings?.length ?? 0,
            preview: envelope.isHeldPreview,
            storage_uri: storageUri,
            size_bytes: off.size_bytes,
          });
          return {
            isError: result.status !== "succeeded",
            content: [{ type: "text" as const, text: summaryLines.join("\n\n") }, resourceLink],
            ...previewMeta,
          };
        }
        const text = serialized;
        logger.info({
          module: "mcp",
          action: "mcp.tool.result",
          msg: "mcp tool call completed",
          tool: name,
          duration_ms: Date.now() - started,
          bytes: text.length,
          execution_id: result.execution_id,
          warnings_count: result.warnings?.length ?? 0,
          preview: envelope.isHeldPreview,
        });
        // structuredContent mirrors the workflow `output` (which the declared
        // `output_schema` describes) — only for a clean, non-preview success
        // where `output` is an object, so it always conforms to the advertised
        // schema. The serialized text block stays for back-compat (spec SHOULD).
        // The offloaded (>cap) branch above intentionally omits it — a
        // resource_link, not an inlined large object.
        const structured =
          outputSchemaDeclared &&
          !envelope.isHeldPreview &&
          result.status === "succeeded" &&
          result.output != null &&
          typeof result.output === "object" &&
          !Array.isArray(result.output)
            ? { structuredContent: result.output as Record<string, unknown> }
            : {};
        return {
          isError: result.status !== "succeeded",
          content: [{ type: "text" as const, text }],
          ...structured,
          ...previewMeta,
        };
      } catch (err) {
        state.bridge?.stop();
        if (state.executionId) cancel(state.executionId);
        const text = toMcpErrorText(err);
        logger.error({
          module: "mcp",
          action: "mcp.tool.error",
          msg: "mcp tool call failed",
          tool: name,
          error: text,
        });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `error: ${text}` }],
        };
      }
    },
  );
}
