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
//   output. Results larger than the 20k char cap reuse the execution's
//   canonical immutable S3 offload pointer.
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
  ElicitResultSchema as McpElicitResultSchema,
  type ServerNotification,
  type ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { and, eq } from "drizzle-orm";
import { actorType } from "../../audit/index.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { getConfig } from "../../config/loader.ts";
import { registerNativeUrlElicitationCompletion } from "../../conversations/native-url-elicitation.ts";
import type { Db } from "../../db/client.ts";
import { executions, workflows, workflowVersions } from "../../db/schema/index.ts";
import { cancel } from "../../execution/abort.ts";
import {
  admitAuthorizedWorkflowExecution,
  auditAdmissionRefusal,
  createExecution,
  runExecution,
} from "../../execution/index.ts";
import { previewOf } from "../../execution/offload.ts";
import { logger } from "../../logging/logger.ts";
import { globalEmitter } from "../../pubsub/emitter.ts";
import type { EventEnvelope } from "../../pubsub/types.ts";
import { CONVERSATION_TOOL_MCP_UNAVAILABLE_REASON, getUnifiedRegistry } from "../../tools/index.ts";
import type { ToolInvocation } from "../../tools/types.ts";
import { gateWorkflowRunRbac } from "../../workflows/rbac.ts";
import { executableDefinition } from "../../workflows/stored-definition.ts";
import { callToolViaDispatcher } from "../adapter.ts";
import { toMcpErrorText } from "../error-adapter.ts";
import { MCP_CORE_TOOL_NAMES, modeFlags, resolveMcpMode } from "../mode-resolver.ts";
import { MCP_OFFLOAD_CHAR_CAP } from "../types.ts";
import { assembleCatalog, DEFAULT_PALETTE_LIMIT, TOOL_PREFIX } from "./catalog-budget.ts";
import { ELICITATION_FORM_TIMEOUT_MS } from "./conversation-native-elicitation.ts";
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
    // The catalog is assembled per mcp mode and published in FULL — no
    // server-side trim. Strict clients (claude.ai, ChatGPT) defer-load large
    // catalogs natively, so the client's own tool-search handles size. Sources:
    //   - listWorkflowTools     — wf_<slug> per-workflow tools (Top-N palette,
    //                             the one remaining bound: DEFAULT_PALETTE_LIMIT).
    //   - listToolsViaRegistry  — unified registry, per-mode set: static
    //                             (authenticate, list_recipes, self_healing.scan
    //                             in admin) plus the conversation tools the mode
    //                             publishes under their bare names.
    //   - listConversationTools — MCP-only conversation.* session tools.
    const mode = resolveMcpMode(principal);
    // We log the client's advertised capabilities (elicitation, sampling,
    // roots, tasks) as a signal only. They are not proof of human approval;
    // saved workflow writes require a locally verified execution authority.
    //
    // The client's self-reported identity rides along. It is SELF-DECLARED and
    // therefore never a permission input — the credential decides what a caller
    // may do. It exists so per-client behaviour is measurable: what a client
    // advertises and what it actually fulfils diverge (a client has advertised
    // `elicitation` and then answered every elicitation with an error), and
    // without this field an aggregate like "0 of 29 elicitations fulfilled"
    // cannot be split by client.
    const clientCaps = server.getClientCapabilities();
    const clientInfo = server.getClientVersion();
    const elicitationCapable = clientCaps?.elicitation != null;
    logger.info({
      module: "mcp",
      action: "mcp.client.capabilities",
      msg: "client capabilities at tools/list",
      elicitation: elicitationCapable,
      sampling: clientCaps?.sampling != null,
      roots: clientCaps?.roots != null,
      tasks: clientCaps?.tasks != null,
      client_name: clientInfo?.name,
      client_version: clientInfo?.version,
      principal_id: principal.id,
      tenant_id: principal.tenant_id,
    });
    // Fetch the wf_ palette (capped to DEFAULT_PALETTE_LIMIT), then assemble the
    // full catalog for the mode.
    const fullPalette = await listWorkflowTools({
      db,
      principal,
      limit: DEFAULT_PALETTE_LIMIT,
    });
    const tools = assembleCatalog({ principal, readOnly, mode, fullPalette });
    // Defense-in-depth: the search-first floor must always be present. The
    // per-mode set includes it by construction (product allow-list + static),
    // but assert it so a future regression is loud rather than silent.
    const presentNames = new Set(tools.map((t) => t.name));
    const missingCore = [...MCP_CORE_TOOL_NAMES].filter((coreName) => !presentNames.has(coreName));
    if (missingCore.length > 0) {
      logger.warn({
        module: "mcp",
        action: "mcp.catalog.floor_violation",
        msg: "search-first core tool(s) missing from the assembled catalog",
        missing: missingCore,
        mode,
        principal_id: principal.id,
        tenant_id: principal.tenant_id,
      });
    }
    logger.info({
      module: "mcp",
      action: "mcp.catalog.assembled",
      msg: "tools/list catalog assembled",
      tool_count: tools.length,
      mode,
      principal_id: principal.id,
      tenant_id: principal.tenant_id,
    });
    // Ship the whole catalog in ONE page when it fits (paginate clamps the
    // page size to its own MAX). The full authoring/admin catalog is bounded
    // (~123 authoring, ~152 admin), so a single response reaches clients that
    // do not follow the pagination cursor; a larger-than-MAX catalog still
    // paginates, with the conversation cluster + named tools ordered first.
    const page = paginate("tools/list", tools, request.params?.cursor, tools.length);
    return {
      tools: page.page,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  });

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => {
      const name = request.params.name;
      const args = request.params.arguments ?? {};
      const progressToken = request.params._meta?.progressToken;
      const envMeta = (request.params._meta as { environment?: unknown } | undefined)?.environment;
      // The client may name the environment (`dev`/`prod`) on `_meta.environment`
      // to pick which credentials the run resolves against; an absent value
      // defaults to dev. Only these two are honored, everything else falls back.
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
        // The dispatcher enforces local human approval for a material effect.
        // Client annotations cannot replace the portal's durable decision.
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
        // Authoring is opt-in per credential, and this branch has to enforce
        // it rather than merely reflect it.
        //
        // The registry path above gates on the resolved mode; this one did not,
        // so a credential without authoring saw no `conversation_*` tool in its
        // catalogue but could still call one by name. That made the mode a
        // display preference on the one branch that actually opens an authoring
        // session — the branch where it matters most.
        //
        // A catalogue omission is not a boundary. Refusing here is what turns
        // "you cannot see it" into "you cannot use it".
        if (!modeFlags(resolveMcpMode(principal), readOnly).showConversationTools) {
          logger.info({
            module: "mcp",
            action: "mcp.tool.mode_denied",
            msg: "conversation tool refused — credential does not carry authoring",
            tool: name,
            principal_id: principal.id,
            tenant_id: principal.tenant_id,
          });
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: CONVERSATION_TOOL_MCP_UNAVAILABLE_REASON,
              },
            ],
          };
        }
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
        const clientCapabilities = server.getClientCapabilities();
        const clientTasksCapable = clientCapabilities?.tasks !== undefined;
        const taskAugmented = taskParamPresent && clientTasksCapable;
        const elicitationCapabilities = clientCapabilities?.elicitation;
        // MCP backwards compatibility: `elicitation: {}` means form support.
        // SDK 1.29's convenience `elicitInput()` does not normalize that form,
        // so issue the typed request directly after this explicit capability check.
        const formElicitationCapable =
          elicitationCapabilities !== undefined &&
          (elicitationCapabilities.form !== undefined || elicitationCapabilities.url === undefined);
        const urlElicitationCapable = elicitationCapabilities?.url !== undefined;
        const result = await handleConversationTool({
          db,
          principal,
          name,
          args: args as Record<string, unknown>,
          ...(permissionMode ? { permission_mode: permissionMode } : {}),
          ...(playground ? { playground } : {}),
          ...(taskAugmented ? { taskAugmented } : {}),
          ...(formElicitationCapable || urlElicitationCapable
            ? {
                nativeElicitation: {
                  // No `signal: extra.signal` here: delivery is detached
                  // from the originating `tools/call` (the poll returns
                  // immediately while the form round-trip stays pending),
                  // so tying it to the dying request's abort signal would
                  // kill the form the moment the poll response is written.
                  ...(formElicitationCapable
                    ? {
                        elicitForm: async (params) =>
                          await server.request(
                            {
                              method: "elicitation/create",
                              params: { mode: "form", ...params },
                            },
                            McpElicitResultSchema,
                            { timeout: ELICITATION_FORM_TIMEOUT_MS },
                          ),
                      }
                    : {}),
                  ...(urlElicitationCapable
                    ? {
                        elicitUrl: async (params) => {
                          const unregister = registerNativeUrlElicitationCompletion(
                            params.elicitationId,
                            server.createElicitationCompletionNotifier(params.elicitationId),
                          );
                          try {
                            const result = await server.request(
                              { method: "elicitation/create", params },
                              McpElicitResultSchema,
                              { timeout: ELICITATION_FORM_TIMEOUT_MS },
                            );
                            if (result.action !== "accept") unregister();
                            return result;
                          } catch (err) {
                            unregister();
                            throw err;
                          }
                        },
                      }
                    : {}),
                },
              }
            : {}),
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
          content: result.content.map((c) => ({
            type: "text" as const,
            text: c.text,
          })),
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
      // A `wf_<slug>` call verifies its product-local authority below; the
      // client's annotation handling is not proof of a human decision.
      return await runWorkflowToolCall({
        db,
        principal,
        extra,
        name,
        args: args as Record<string, unknown>,
        progressToken,
        execution_mode,
        started,
      });
    },
  );
}

/** One `wf_<slug>` execution hop. RBAC gate, progress bridge, offload, and
 *  result envelope live here. */
interface WorkflowToolCallParams {
  readonly db: Db;
  readonly principal: ResolvedPrincipal;
  readonly extra: RequestHandlerExtra<ServerRequest, ServerNotification>;
  /** Full MCP tool name (`wf_<slug>`). */
  readonly name: string;
  /** The workflow's own inputs — verbatim from the call. Never carries an
   *  engine-owned key: the advertised inputSchema is the workflow's authored
   *  `input_schema`. */
  readonly args: Record<string, unknown>;
  readonly progressToken: string | number | undefined;
  /** Which environment's credentials the run resolves against. */
  readonly execution_mode: "dev" | "prod";
  /** tools/call receipt timestamp, so the run logs one honest duration. */
  readonly started: number;
}

/**
 * Run a saved workflow behind its `wf_<slug>` tool.
 *
 * Writes require a locally stored, exact-version execution authority. Without
 * one, only conservative preparation runs. Client annotation dialogs grant no
 * server-side authority. RBAC applies to both paths.
 */
async function runWorkflowToolCall(p: WorkflowToolCallParams): Promise<CallToolResult> {
  const { db, principal, extra, name, args, progressToken, execution_mode, started } = p;
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
  const wfRows = await db
    .select({ current_version_id: workflows.current_version_id })
    .from(workflows)
    .where(and(eq(workflows.tenant_id, principal.tenant_id), eq(workflows.id, wf.id)))
    .limit(1);
  const vId = wfRows[0]?.current_version_id;
  if (!vId) throw new Error("workflow version unavailable");
  const vRows = await db
    .select({ dag: workflowVersions.dag })
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.tenant_id, principal.tenant_id),
        eq(workflowVersions.workflow_id, wf.id),
        eq(workflowVersions.id, vId),
      ),
    )
    .limit(1);
  const definition = executableDefinition(vRows[0]?.dag);
  const totalSteps = definition.steps.length;
  const outputSchemaDeclared = definition.output_schema != null;
  let executionId: string;
  let preparation = false;
  try {
    const admitted = await admitAuthorizedWorkflowExecution(
      {
        tenant_id: principal.tenant_id,
        workflow_id: wf.id,
        workflow_version_id: vId,
        execution_environment: execution_mode,
        request_source: "mcp",
        input: args,
      },
      db,
    );
    executionId = admitted.execution_id;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (
      !code ||
      ![
        "execution_authority_required",
        "execution_authority_unavailable",
        "execution_authority_changed",
        "workflow_version_not_active",
      ].includes(code)
    )
      throw error;
    preparation = true;
    executionId = await createExecution(db, {
      tenant_id: principal.tenant_id,
      workflow_id: wf.id,
      workflow_version_id: vId,
      execution_mode,
      source_kind: "saved",
      source_ref: null,
      input: args,
      request_source: "mcp",
    });
    // The refusal and the run that replaced it are one event, so they are one
    // row. Filed against the preparation's id with `downgraded_to_preparation`:
    // pointing at nothing would read as "the call was refused and stopped",
    // while an unrelated held run then succeeded under a different id.
    await auditAdmissionRefusal(
      {
        tenant_id: principal.tenant_id,
        reason: code,
        message: (error as Error).message,
        workflow_id: wf.id,
        execution_id: executionId,
        request_source: "mcp",
        actor_id: principal.id,
        actor_type: actorType(principal),
        extra: { downgraded_to_preparation: true, tool: name },
      },
      db,
    );
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
    runSettled: boolean;
  } = { bridge: null, executionId, runSettled: false };
  const settleProgressBridge = (): void => {
    state.runSettled = true;
    state.bridge?.stop();
  };
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
    source: { kind: "saved", workflow_id: wf.id, version_id: vId },
    input: args,
    options: {
      existing_execution_id: executionId,
      ...(preparation ? { hold_writes: true, self_healing: { enabled: false } } : {}),
      request_source: "mcp",
      signal: abortController.signal,
      trace_id: null,
      principal,
      execution_mode,
    },
  });

  // The admission-created id belongs to this call even during parallel runs.
  if (progressToken !== undefined && progressToken !== null) {
    state.bridge = startProgressBridge(db, principal.tenant_id, executionId, totalSteps, notifier);
  }

  try {
    // Bound the inline wait so a slow run doesn't blow past the client's
    // request timeout. On timeout, detach the cancel wiring (so completing
    // the response doesn't abort the run), let it finish in the
    // background, and hand back a polling handle.
    const outcome = await raceInlineRun(runPromise, WF_INLINE_TIMEOUT_MS);
    if (outcome.timedOut) {
      // Still running — stop blocking the client but keep the run alive.
      extra.signal.removeEventListener("abort", onSignalAbort);
      void runPromise.then(settleProgressBridge, settleProgressBridge);
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
    settleProgressBridge();
    // When a run produced non-fatal warnings (e.g. jsonata
    // `unresolved_identifier`), wrap the output so the MCP client sees
    // them alongside the payload. See held-preview.ts.
    const hasWarnings = (result.warnings?.length ?? 0) > 0;
    // Final progress frame @ 1.0.
    if (progressToken !== undefined && progressToken !== null) {
      await notifier.send(1, 1, "completed").catch(() => {});
    }
    const { rawBody, held } = buildResultEnvelope(result);
    // Offload if oversize. Warnings travel with the envelope.
    const serialized = JSON.stringify(rawBody);
    if (serialized.length > MCP_OFFLOAD_CHAR_CAP) {
      const [persisted] = await db
        .select({ result_storage_uri: executions.result_storage_uri })
        .from(executions)
        .where(
          and(
            eq(executions.tenant_id, principal.tenant_id),
            eq(executions.id, result.execution_id),
          ),
        )
        .limit(1);
      const outputSerialized = JSON.stringify(result.output) ?? "null";
      const off = {
        storage_uri: persisted?.result_storage_uri ?? null,
        preview: previewOf(result.output),
        size_bytes: Buffer.byteLength(outputSerialized, "utf8"),
      };
      // MCP `resource_link` content block. The previous
      // text-encoded JSON envelope forced clients to parse a string
      // field to discover the object URI; LLM agents rarely follow
      // such pointers without explicit instruction.
      // `resource_link` is the native protocol affordance: compliant
      // clients can auto-fetch, surface to the user, or expose the
      // URI as a follow-up call. Pairs with the `s3://` reader
      // in apps/engine/src/mcp/capabilities/resources.ts.
      const summaryLines: string[] = [
        `${held ? "Preparation (external effects held)" : "Execution"} ${result.execution_id} ${result.status}; result is ${off.size_bytes} bytes (offloaded — inline cap is ${MCP_OFFLOAD_CHAR_CAP} bytes).`,
      ];
      if (off.preview) summaryLines.push(`Preview: ${off.preview}`);
      if (hasWarnings) {
        summaryLines.push(`Warnings: ${JSON.stringify(result.warnings)}`);
      }
      const storageUri = off.storage_uri;
      if (!storageUri) {
        // A >20 KB result should already have crossed the execution's 10 KB
        // offload threshold. If persistence did not materialize a pointer,
        // return inline rather than creating an unowned/orphan object.
        return {
          isError: held || result.status !== "succeeded",
          content: [{ type: "text" as const, text: serialized }],
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
        storage_uri: storageUri,
        size_bytes: off.size_bytes,
      });
      return {
        isError: held || result.status !== "succeeded",
        content: [{ type: "text" as const, text: summaryLines.join("\n\n") }, resourceLink],
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
    });
    // structuredContent mirrors the workflow `output` (which the declared
    // `output_schema` describes) — only for a clean success where `output` is
    // an object, so it always conforms to the advertised schema. The serialized
    // text block stays for back-compat (spec SHOULD). The offloaded (>cap)
    // branch above intentionally omits it — a resource_link, not an inlined
    // large object.
    const structured =
      outputSchemaDeclared &&
      !held &&
      result.status === "succeeded" &&
      result.output != null &&
      typeof result.output === "object" &&
      !Array.isArray(result.output)
        ? { structuredContent: result.output as Record<string, unknown> }
        : {};
    return {
      // The requested live result is unavailable. MCP clients must not validate
      // held preparation against the workflow's final outputSchema.
      isError: held || result.status !== "succeeded",
      content: [{ type: "text" as const, text }],
      ...structured,
    };
  } catch (err) {
    settleProgressBridge();
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
