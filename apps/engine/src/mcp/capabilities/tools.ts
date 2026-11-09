import { createHash } from "node:crypto";
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
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { getConfig } from "../../config/loader.ts";
import { registerNativeUrlElicitationCompletion } from "../../conversations/public/elicitation.ts";
import type { Db } from "../../db/client.ts";
import { executions } from "../../db/schema/index.ts";
import { cancel } from "../../execution/abort.ts";
import { resolveDefinition } from "../../execution/index.ts";
import { previewOf } from "../../execution/offload.ts";
import {
  createRunWorkflow,
  principalExecutionEnvironment,
} from "../../execution/use-cases/run-workflow.ts";
import { logger } from "../../logging/logger.ts";
import { globalEmitter } from "../../pubsub/emitter.ts";
import type { EventEnvelope } from "../../pubsub/types.ts";
import { CONVERSATION_TOOL_MCP_UNAVAILABLE_REASON, getUnifiedRegistry } from "../../tools/index.ts";
import type { ToolInvocation } from "../../tools/types.ts";
import { callToolViaDispatcher } from "../adapter.ts";
import { toMcpErrorText } from "../error-adapter.ts";
import { MCP_CORE_TOOL_NAMES, modeFlags, resolveMcpMode } from "../mode-resolver.ts";
import { MCP_OFFLOAD_CHAR_CAP } from "../types.ts";
import { assembleCatalog, DEFAULT_PALETTE_LIMIT, TOOL_PREFIX } from "./catalog-budget.ts";
import { ELICITATION_FORM_TIMEOUT_MS } from "./conversation-native-elicitation.ts";
import { handleConversationTool, isConversationToolName } from "./conversations.ts";
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
import { workflowRunRefusalResult, workflowRunReplayResult } from "./workflow-run-refusal.ts";

const WF_INLINE_TIMEOUT_MS = 50_000;
const TOOLS_CALL_DEADLINE_MS = 30_000;
const TOOL_LIST_CHANGED_DEBOUNCE_MS = 250;

interface RegisterToolsParams {
  server: Server;
  db: Db;
  principal: ResolvedPrincipal;
  transport: "http" | "stdio";
}

export function registerToolsCapability(p: RegisterToolsParams): void {
  const { server, db, principal } = p;

  server.registerCapabilities({ tools: { listChanged: true } });

  let listChangedTimer: ReturnType<typeof setTimeout> | undefined;
  const offWorkflowLifecycle = globalEmitter.on(
    "workflow.lifecycle",
    (event: EventEnvelope<unknown>) => {
      if (event.tenant_id !== principal.tenant_id) return;
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
      } catch {}
    }
  };

  let readOnly = false;
  try {
    readOnly = getConfig().mcp.read_only;
  } catch {}

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const mode = resolveMcpMode(principal);
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
    const fullPalette = await listWorkflowTools({
      db,
      principal,
      limit: DEFAULT_PALETTE_LIMIT,
    });
    const tools = assembleCatalog({ principal, readOnly, mode, fullPalette });
    const catalogFingerprint = createHash("sha256")
      .update(
        tools
          .map((tool) => tool.name)
          .sort()
          .join("\n"),
      )
      .digest("hex")
      .slice(0, 16);
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
      catalog_fingerprint: catalogFingerprint,
      client_name: clientInfo?.name,
      client_version: clientInfo?.version,
      cursor_present: request.params?.cursor !== undefined,
      mode,
      principal_id: principal.id,
      tenant_id: principal.tenant_id,
    });
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
      let requestedEnvironment: "dev" | "prod" | undefined;
      if (typeof envMeta === "string") {
        const normalized = envMeta.toLowerCase();
        if (normalized === "dev" || normalized === "prod") {
          requestedEnvironment = normalized;
        }
      }
      const execution_mode = principalExecutionEnvironment(principal, requestedEnvironment ?? null);
      const idempotencyMeta = (request.params._meta as { idempotency_key?: unknown } | undefined)
        ?.idempotency_key;
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

      const mcpModeForCall = resolveMcpMode(principal);
      const readOnlyForCall = !modeFlags(mcpModeForCall, readOnly).showTenantWrites;

      const probeEntry = getUnifiedRegistry().get(name, {
        surface: "mcp",
        mcpMode: mcpModeForCall,
        readOnly: readOnlyForCall,
      });
      if (probeEntry) {
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
        const raced = await raceInlineRun(
          callToolViaDispatcher({
            db,
            principal,
            mcpMode: mcpModeForCall,
            readOnly: readOnlyForCall,
            invocation,
            clientName: server.getClientVersion()?.name,
          }),
          TOOLS_CALL_DEADLINE_MS,
        );
        if (raced.timedOut) {
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

      if (isConversationToolName(name)) {
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
        const playground =
          (request.params._meta as { sk_playground?: unknown } | undefined)?.sk_playground === true;
        const taskParamPresent = request.params.task !== undefined;
        const clientCapabilities = server.getClientCapabilities();
        const clientTasksCapable = clientCapabilities?.tasks !== undefined;
        const taskAugmented = taskParamPresent && clientTasksCapable;
        const elicitationCapabilities = clientCapabilities?.elicitation;
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
        progressToken,
        execution_mode,
        ...(typeof idempotencyMeta === "string" ? { idempotency_key: idempotencyMeta } : {}),
        started,
      });
    },
  );
}

interface WorkflowToolCallParams {
  readonly db: Db;
  readonly principal: ResolvedPrincipal;
  readonly extra: RequestHandlerExtra<ServerRequest, ServerNotification>;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly progressToken: string | number | undefined;
  readonly execution_mode: "dev" | "prod";
  readonly idempotency_key?: string;
  readonly started: number;
}

function rbacDeniedError(message: string): Error {
  return Object.assign(new Error(message), { code: -32001 });
}

async function runWorkflowToolCall(p: WorkflowToolCallParams): Promise<CallToolResult> {
  const { db, principal, extra, name, args, progressToken, execution_mode, started } = p;
  const slug = name.slice(TOOL_PREFIX.length);
  const useCase = createRunWorkflow({ db });
  const wf = await resolveWorkflowBySlug(db, principal.tenant_id, slug);
  if (!wf) {
    const denied = await useCase.authorizeUnresolved({
      principal,
      via: "mcp",
      tool: name,
      workflow_slug: slug,
    });
    if (denied) throw rbacDeniedError(denied.message);
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

  const grant = await useCase.authorize({
    principal,
    workflow_id: wf.id,
    workflow_slug: slug,
    via: "mcp",
    tool: name,
  });
  if (grant.kind === "rejected") throw rbacDeniedError(grant.message);

  const abortController = new AbortController();
  const onSignalAbort = (): void => {
    abortController.abort("mcp_cancelled");
  };
  if (extra.signal.aborted) onSignalAbort();
  else extra.signal.addEventListener("abort", onSignalAbort, { once: true });

  const state: {
    bridge: { stop: () => void } | null;
    runSettled: boolean;
  } = { bridge: null, runSettled: false };
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

  const outcome = await useCase.runWorkflow({
    principal,
    workflow_id: wf.id,
    execution_environment: execution_mode,
    request_source: "mcp",
    input: args,
    idempotency_key: p.idempotency_key ?? null,
    authorization: { kind: "granted", workflow_permission: grant.workflow_permission },
    audit_extra: { tool: name },
    dispatch: { mode: "background", signal: abortController.signal, trace_id: null },
  });
  if (outcome.kind === "rejected" || outcome.kind === "replayed") {
    extra.signal.removeEventListener("abort", onSignalAbort);
    logger.info({
      module: "mcp",
      action: "mcp.tool.result",
      msg:
        outcome.kind === "rejected"
          ? "mcp wf run refused at admission — returned terminal cannot_help"
          : "mcp wf run replayed an idempotent execution",
      tool: name,
      duration_ms: Date.now() - started,
      ...(outcome.kind === "rejected"
        ? { error_code: outcome.code }
        : { execution_id: outcome.admitted.execution_id }),
    });
    return outcome.kind === "rejected"
      ? workflowRunRefusalResult(outcome, slug)
      : workflowRunReplayResult(slug, outcome.admitted);
  }
  const executionId = outcome.admitted.execution_id;
  const runPromise = outcome.settled;

  try {
    const definition = (
      await resolveDefinition(db, principal.tenant_id, {
        kind: "saved",
        workflow_id: wf.id,
        version_id: outcome.admitted.workflow_version_id,
      })
    ).def;
    const outputSchemaDeclared = definition.output_schema != null;
    if (progressToken !== undefined && progressToken !== null) {
      state.bridge = startProgressBridge(
        db,
        principal.tenant_id,
        executionId,
        definition.steps.length,
        notifier,
      );
    }
    const raced = await raceInlineRun(runPromise, WF_INLINE_TIMEOUT_MS);
    if (raced.timedOut) {
      extra.signal.removeEventListener("abort", onSignalAbort);
      void runPromise.then(settleProgressBridge, settleProgressBridge);
      logger.info({
        module: "mcp",
        action: "mcp.tool.result",
        msg: "mcp wf run exceeded inline window — returned polling handle",
        tool: name,
        duration_ms: Date.now() - started,
        execution_id: executionId,
      });
      return {
        isError: false,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              status: "running",
              execution_id: executionId,
              message: `Workflow ${slug} is still running after ${Math.round(
                WF_INLINE_TIMEOUT_MS / 1000,
              )}s. Poll get_execution with this execution_id for the result.`,
              poll_with: "get_execution",
            }),
          },
        ],
        _meta: { subkit: { execution: { id: executionId, status: "running" } } },
      };
    }
    if (raced.result.kind === "rejected") {
      settleProgressBridge();
      return workflowRunRefusalResult(raced.result, slug);
    }
    const result = raced.result.result;
    settleProgressBridge();
    const hasWarnings = (result.warnings?.length ?? 0) > 0;
    if (progressToken !== undefined && progressToken !== null) {
      await notifier.send(1, 1, "completed").catch(() => {});
    }
    const { rawBody, held } = buildResultEnvelope(result);
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
      const summaryLines: string[] = [
        `${held ? "Preparation (external effects held)" : "Execution"} ${result.execution_id} ${result.status}; result is ${off.size_bytes} bytes (offloaded — inline cap is ${MCP_OFFLOAD_CHAR_CAP} bytes).`,
      ];
      if (off.preview) summaryLines.push(`Preview: ${off.preview}`);
      if (hasWarnings) {
        summaryLines.push(`Warnings: ${JSON.stringify(result.warnings)}`);
      }
      const storageUri = off.storage_uri;
      if (!storageUri) {
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
      isError: held || result.status !== "succeeded",
      content: [{ type: "text" as const, text }],
      ...structured,
    };
  } catch (err) {
    settleProgressBridge();
    cancel(executionId);
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
    principal,
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
