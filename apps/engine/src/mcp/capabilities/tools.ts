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
  type CallToolResult,
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
import {
  approvalAuditResource,
  type ClaimedApproval,
  consumeApproval,
  recordApprovalApproved,
  recordApprovalUnfulfilled,
  requestApproval,
} from "../../tools/approval.ts";
import { getUnifiedRegistry } from "../../tools/index.ts";
import type { ToolInvocation } from "../../tools/types.ts";
import { gateWorkflowRunRbac } from "../../workflows/rbac.ts";
import { WorkflowDefSchema } from "../../workflows/types.ts";
import { callToolViaDispatcher } from "../adapter.ts";
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
import { approvalAffordanceLine, buildResultEnvelope, type PreviewCommit } from "./held-preview.ts";
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
    //                             plus the conversation tools the mode's
    //                             allow-list publishes under their bare names.
    //   - listConversationTools — MCP-only conversation.* session tools.
    //   - CONFIRM_TOOL_CALL_TOOL — always appended as the confirm fallback.
    // Nothing becomes unreachable: trimmed workflows stay callable via
    // find_workflow / run_workflow(slug), and an unpublished registry tool
    // still resolves on tools/call and inside conversation_start's loop.
    const initialMode = resolveMcpMode(principal);
    // The confirm responder is always surfaced (see assembleTier), for EVERY
    // client. It cannot approve anything — an approval is granted by a human at
    // its `approval_url` — so there is nothing for a capability check to protect.
    // Every write approval over MCP is portal-only: in-band elicitation is not a
    // grant channel (claude.ai auto-declines the prompt, and 29/29 prompts timed
    // out in production). We log the client's elicitation capability as a signal
    // only; it changes nothing about how an approval is granted.
    const clientCaps = server.getClientCapabilities();
    const elicitationCapable = clientCaps?.elicitation != null;
    logger.info({
      module: "mcp",
      action: "mcp.client.capabilities",
      msg: "client capabilities at tools/list",
      elicitation: elicitationCapable,
      sampling: clientCaps?.sampling != null,
      roots: clientCaps?.roots != null,
      tasks: clientCaps?.tasks != null,
      confirm_path: "portal",
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
    // Product + authoring publish bounded allow-lists and fit the budget. Admin
    // publishes the full inventory and can legitimately stay over it (its
    // principals are deliberately-minted operator keys). So over-budget is
    // informational (in the fitted event), not a warning; the only alarm is a
    // floor violation (above). An over-budget authoring catalog means the
    // allow-list outgrew the budget — see fitCatalogToBudget.
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
      // Distinguish "the client named an environment" from "it named none".
      // On a first-touch call the absent case defaults to dev; on a
      // `confirm_tool_call` the absent case means "replay in whatever
      // environment the approval was granted for", while a NAMED one that
      // contradicts the stored row is rejected by `consumeApproval`. Silently
      // defaulting both to dev would have let a prod preview be confirmed as
      // dev, and (worse) an absent-vs-prod client swap the other way.
      let requestedEnvironment: "dev" | "prod" | undefined;
      if (typeof envMeta === "string") {
        const normalized = envMeta.toLowerCase();
        if (normalized === "dev" || normalized === "prod") {
          requestedEnvironment = normalized;
        }
      }
      const execution_mode: "dev" | "prod" = requestedEnvironment ?? "dev";
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

      // Confirm responder — a TRIGGER, not a gate, and therefore open to every
      // client. The first call persisted the args and opened the approval
      // UNGRANTED (APPROVAL_REQUESTED); a HUMAN grants it at the `approval_url`
      // that call handed back. This responder claims a GRANTED approval and
      // replays those args — the caller carries back an id and nothing else.
      //
      // There is deliberately NO capability-based refusal here. `confirm_tool_call`
      // can no longer approve anything: `consumeApproval` requires `granted_at IS
      // NOT NULL`, which only `grantApproval` sets, and only a human channel
      // reaches that. So refusing an elicitation-capable client would protect
      // nothing and would strand the very clients the refusal was meant to
      // protect — production shows all 29 of their in-band prompts timed out and
      // not one was ever fulfilled. Every client may call it; it succeeds iff a
      // human already granted the approval.
      //
      // Handled before the registry probe because neither the responder nor
      // `wf_<slug>` is a registry tool.
      if (name === CONFIRM_TOOL_CALL_NAME) {
        const targetTool = typeof args.tool === "string" ? args.tool : "";
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

        // `wf_<slug>` is not a registry tool (tools/index.ts registers no
        // `wf_` provider), so a dispatcher re-dispatch resolves to
        // `tool_not_found`. Claim the approval the held preview opened — the
        // claim succeeds only if a human granted it — and replay the stored
        // inputs against the workflow executor with the writes released.
        // `runWorkflowToolCall` re-runs the RBAC gate (a grant can be revoked
        // between preview and approval) and only then records APPROVAL_APPROVED.
        if (targetTool.startsWith(TOOL_PREFIX)) {
          const claim = await consumeApproval({
            db,
            principal,
            approval_id: confirmId,
            tool: targetTool,
            surface: "mcp",
            via: "mcp",
            execution_mode: requestedEnvironment,
          });
          if (!claim.ok) {
            logger.info({
              module: "mcp",
              action: "mcp.tool.confirm_rejected",
              msg: "confirm_tool_call could not claim the approval",
              tool: targetTool,
              error_code: claim.code,
              duration_ms: Date.now() - started,
              principal_id: principal.id,
              tenant_id: principal.tenant_id,
            });
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({ error_code: claim.code, message: claim.message }),
                },
              ],
            };
          }
          return await runWorkflowToolCall({
            db,
            principal,
            extra,
            name: targetTool,
            args: claim.args,
            holdWrites: false,
            progressToken,
            // The STORED environment, never the confirming call's. The operator
            // approved a preview of one system; the replay runs against that
            // system. `null` is unreachable for a wf_ approval (the preview
            // always persists one) — dev is the safe floor if it ever is.
            execution_mode: claim.execution_mode ?? "dev",
            approval: claim,
            started,
          });
        }

        const confirmedInvocation: ToolInvocation = {
          surface: "mcp",
          name: targetTool,
          args: {},
          meta: { sk_confirm: true, sk_confirm_id: confirmId },
        };
        // Bound the confirmed re-dispatch exactly like the first call. Without
        // it the approved run blocked until the client's own ~60s abort, and
        // the retry that followed executed the work a second time.
        const raced = await raceInlineRun(
          callToolViaDispatcher({
            db,
            principal,
            mcpMode: mcpModeForCall,
            readOnly: readOnlyForCall,
            invocation: confirmedInvocation,
          }),
          TOOLS_CALL_DEADLINE_MS,
        );
        if (raced.timedOut) {
          // Same async-ack as the direct path: a confirmed `run_workflow`
          // keeps running past the deadline, so hand back its execution_id
          // rather than a bare `engine_busy` the client would retry into a
          // duplicate run. The confirm carries no args, so the target resolves
          // from the caller's conversation-bound workflow.
          if (targetTool === "run_workflow") {
            const ack = await buildRunWorkflowAsyncAck({
              db,
              principal,
              workflowArg: undefined,
              started,
            });
            if (ack) return ack;
          }
          return engineBusyResult(targetTool, {
            principal,
            started,
          });
        }
        const response = raced.result;
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
        // Human-in-the-loop over MCP is portal-only. A `confirm_before_execution`
        // tool mints its approval UNGRANTED and `dispatchTool#gateConfirm` hands
        // back a `needs_confirm` envelope carrying the `approval_url` a person
        // grants at, out of band. A `_meta.sk_confirm` marker is a TRIGGER, not an
        // approval: `dispatchTool` claims with it, and the claim fails on any
        // approval a human has not granted. No in-band elicitation participates.
        //
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
            const ack = await buildRunWorkflowAsyncAck({
              db,
              principal,
              workflowArg: typeof args.workflow === "string" ? args.workflow : undefined,
              started,
            });
            if (ack) return ack;
          }
          return engineBusyResult(name, { principal, started });
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
      return await runWorkflowToolCall({
        db,
        principal,
        extra,
        name,
        args: args as Record<string, unknown>,
        // Every first-touch `wf_<slug>` call holds its write-classified steps
        // (sends, publishes, external writes): they resolve but never dispatch.
        // Releasing them requires a HUMAN who grants the approval at its
        // `approval_url` (portal-only over MCP); `confirm_tool_call` then triggers
        // the granted approval. The scheduler/HTTP run paths don't route through
        // this handler, so production runs still send.
        holdWrites: true,
        progressToken,
        execution_mode,
        started,
      });
    },
  );
}

/** One `wf_<slug>` execution hop. The first call (writes held) and the
 *  confirmed replay (writes released) go through the SAME function, so the
 *  RBAC gate, progress bridge, offload, and preview envelope cannot drift. */
interface WorkflowToolCallParams {
  readonly db: Db;
  readonly principal: ResolvedPrincipal;
  readonly extra: RequestHandlerExtra<ServerRequest, ServerNotification>;
  /** Full MCP tool name (`wf_<slug>`) — also the approval's tool identity. */
  readonly name: string;
  /** The workflow's own inputs — verbatim from the call, or replayed out of
   *  the approval on the confirmed hop. Never carries an engine-owned key:
   *  the advertised inputSchema is the workflow's authored `input_schema`. */
  readonly args: Record<string, unknown>;
  /** True on every first-touch call; false only on the confirmed replay. */
  readonly holdWrites: boolean;
  readonly progressToken: string | number | undefined;
  /** On the confirmed replay this is the approval's STORED environment. */
  readonly execution_mode: "dev" | "prod";
  /** The burned approval this hop replays, on the confirmed hop only. Its
   *  APPROVAL_APPROVED row is written here — after the RBAC gate, before the
   *  execution starts. */
  readonly approval?: ClaimedApproval;
  /** tools/call receipt timestamp, so both hops log one honest duration. */
  readonly started: number;
}

/**
 * Run a saved workflow behind its `wf_<slug>` tool.
 *
 * Preview-to-commit: the first call ALWAYS holds writes. When the run comes
 * back carrying the mandatory `held_preview_no_writes` warning, a HUMAN — never
 * the model — decides whether those writes run. `gateHeldWrites` opens the
 * approval UNGRANTED and mints its `approval_url`, then hands `confirm_id` +
 * `approval_url` back inside the preview envelope. Over MCP this is the ONLY
 * grant channel — in-band elicitation is not one (claude.ai auto-declines the
 * prompt, and production saw 29/29 prompts time out). A person grants the
 * approval at that link; `confirm_tool_call` then TRIGGERS this function again
 * with `holdWrites:false`.
 *
 * There is no `execute_writes` opt-in: a model-driven client cannot set
 * transport-level `_meta`, and the workflow's own input schema has no room for
 * an engine key.
 *
 * A read-only workflow emits no held-preview warning and therefore opens no
 * approval row. The confirmed replay re-executes the read steps — the honest
 * cost of a preview the operator could inspect before committing.
 */
async function runWorkflowToolCall(p: WorkflowToolCallParams): Promise<CallToolResult> {
  const {
    db,
    principal,
    extra,
    name,
    args,
    holdWrites,
    progressToken,
    execution_mode,
    approval,
    started,
  } = p;
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
    // The confirmed replay burned its single-use handle before we learned the
    // workflow is gone. Close the approval's lifecycle on its own id: the audit
    // trail must record the OUTCOME (this approval released nothing), not stop
    // at the APPROVAL_REQUESTED that opened it.
    if (approval) {
      await recordApprovalUnfulfilled({
        db,
        principal,
        claim: approval,
        tool: name,
        via: "mcp",
        reason: "workflow_not_found",
      });
    }
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
  // audit metadata. Runs on the confirmed replay too: a grant can be
  // revoked between the held preview and its approval.
  const rbac = await gateWorkflowRunRbac({
    db,
    principal,
    workflow_id: wf.id,
    workflow_slug: slug,
    request_source: "mcp",
    tool: name,
    ...(approval ? { approval: approvalAuditResource(approval) } : {}),
  });
  if (!rbac.allow) {
    const err = new Error(rbac.error_message) as Error & { code?: number };
    err.code = -32001;
    throw err;
  }

  // The claim survived the RBAC gate: this call IS approved, and the writes
  // are about to leave the perimeter. An audit row that cannot be persisted
  // means the approved write would run unrecorded — refuse instead.
  if (approval) {
    const recorded = await recordApprovalApproved({
      db,
      principal,
      claim: approval,
      tool: name,
      via: "mcp",
    });
    if (!recorded) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error_code: "approval_audit_failed",
              message: `Confirmation ${approval.approval_id} could not be recorded in the audit log; ${name} did not run. Re-issue the call to obtain a fresh confirmation.`,
            }),
          },
        ],
      };
    }
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
          and(eq(workflowVersions.tenant_id, principal.tenant_id), eq(workflowVersions.id, vId)),
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
      ...(holdWrites ? { hold_writes: true } : {}),
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
            and(eq(executions.tenant_id, principal.tenant_id), eq(executions.workflow_id, wf.id)),
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
        // that is the confusing non-terminal state. The run IS alive in the
        // background. Name NO polling tool: without an id there is nothing
        // for `get_execution` to fetch, and `list_executions` is published in
        // neither product nor authoring mode, so pointing at it would send
        // the caller into an `unknown_tool` rejection. The only correct
        // instruction is "it is running; do not re-run it".
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
                )}s, but its execution id was not captured in time, so there is no handle to poll. It is ALREADY in progress — do NOT re-run it. Tell the user the run is under way and that its result will land in the workflow's run history.`,
                poll_with: null,
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
    // When a run produced non-fatal warnings (e.g. jsonata
    // `unresolved_identifier`), wrap the output so the MCP client sees
    // them alongside the payload. On top of that, a held-writes preview
    // (every first-touch wf_* run) gets a first-class `preview` envelope +
    // `_meta` flag so the model cannot mistake it for a real write —
    // the "gemeldet ≠ geschrieben" no-op. See held-preview.ts.
    const hasWarnings = (result.warnings?.length ?? 0) > 0;
    // Probe the envelope with no commit decision attached: we need to know
    // whether the run held a write before we can decide who approves it.
    const probe = buildResultEnvelope(result);
    let commit: PreviewCommit | undefined;
    if (probe.isHeldPreview && holdWrites) {
      commit = await gateHeldWrites({
        db,
        principal,
        name,
        execution_mode,
        args,
        preview: probe.rawBody as { held_steps?: unknown; would_write?: unknown },
      });
    }
    // Final progress frame @ 1.0. Emitted only on the hop that actually
    // answers the client — an in-band approval recurses above and the replay
    // closes out its own progress.
    if (progressToken !== undefined && progressToken !== null) {
      await notifier.send(1, 1, "completed").catch(() => {});
    }
    const envelope = buildResultEnvelope(result, commit);
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
        // The offloaded body is the workflow output, not the preview envelope,
        // so the human's approval affordance would otherwise be unreachable from
        // the summary the client actually reads. Same sentence the inline
        // envelope carries (`approvalAffordanceLine`) so the two cannot drift.
        summaryLines.push(
          `⚠ PREVIEW — no writes performed. ${envelope.heldMessage}` +
            (commit?.kind === "confirm_required" ? approvalAffordanceLine(commit) : ""),
        );
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
      writes_held: holdWrites,
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
}

/**
 * Open the approval a `wf_<slug>` preview's held writes need, and hand its
 * `approval_url` back inside the preview envelope. Portal-only: the model is
 * never the approver, and nothing over MCP grants the approval in-band.
 *
 * The approval is opened UNGRANTED. A person opens the `approval_url` and grants
 * it out of band; `confirm_tool_call` then TRIGGERS the granted row and replays
 * the args the engine persisted here. In-band elicitation is deliberately NOT a
 * grant channel over MCP: claude.ai auto-declines the prompt with no human ever
 * seeing it, and production recorded 29/29 elicitation prompts timing out — an
 * in-band answer is never a verified human decision.
 */
async function gateHeldWrites(p: {
  db: Db;
  principal: ResolvedPrincipal;
  name: string;
  execution_mode: "dev" | "prod";
  args: Record<string, unknown>;
  preview: { held_steps?: unknown; would_write?: unknown };
}): Promise<PreviewCommit> {
  const { db, principal, name, execution_mode, args, preview } = p;
  const approvalId = crypto.randomUUID();

  const { approval_url } = await requestApproval({
    db,
    principal,
    approval_id: approvalId,
    tool: name,
    surface: "mcp",
    via: "mcp",
    // Not a policy-table verdict: the RUN held its writes.
    reason: "held_writes",
    // Bind the environment the preview actually ran in. It arrives
    // out-of-band on `_meta.environment`, so `args_hash` does not cover it —
    // without this column the confirmed replay could target the other
    // system's credentials.
    execution_mode,
    args,
    // What the human reads in the approval portal before they decide. On MCP the
    // portal is the only channel that reaches them.
    preview,
  });
  return {
    kind: "confirm_required",
    tool: name,
    confirm_id: approvalId,
    approval_url,
    reason: "portal_grant_required",
  };
}

/**
 * Async-ack for a `run_workflow` dispatch that outlived the inline deadline:
 * hand back the live execution_id poll handle instead of a bare `engine_busy`
 * the client would retry into a duplicate run. Mirrors run_workflow's own
 * target precedence — explicit `workflow` arg first, else the workflow most
 * recently bound to the caller's conversation (the confirmed re-dispatch
 * carries no args at all, so it always takes the bound-target path). Returns
 * null when no in-window execution can be attributed; the caller then falls
 * back to the honest `engine_busy`.
 */
async function buildRunWorkflowAsyncAck(p: {
  db: Db;
  principal: ResolvedPrincipal;
  workflowArg: string | undefined;
  started: number;
}): Promise<CallToolResult | null> {
  const { db, principal, workflowArg, started } = p;
  let workflowRef = workflowArg;
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
  if (!execId) return null;
  logger.info({
    module: "mcp",
    action: "mcp.tool.result",
    msg: "run_workflow exceeded inline deadline — returned polling handle",
    tool: "run_workflow",
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

/** Terminal `engine_busy` for a dispatch that outlived the inline deadline
 *  with nothing pollable to hand back. The dispatch keeps running in the
 *  background; we only stop blocking on it. */
function engineBusyResult(
  tool: string,
  ctx: { principal: ResolvedPrincipal; started: number },
): CallToolResult {
  logger.warn({
    module: "mcp",
    action: "mcp.tool.deadline_exceeded",
    msg: "mcp tool call exceeded the inline deadline; returned engine-busy",
    tool,
    deadline_ms: TOOLS_CALL_DEADLINE_MS,
    duration_ms: Date.now() - ctx.started,
    principal_id: ctx.principal.id,
    tenant_id: ctx.principal.tenant_id,
  });
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          error_code: "engine_busy",
          message: `Tool "${tool}" did not respond within ${Math.round(
            TOOLS_CALL_DEADLINE_MS / 1000,
          )}s (engine busy). Please retry.`,
        }),
      },
    ],
  };
}
