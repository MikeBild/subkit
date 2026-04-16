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
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { and, asc, eq, isNull } from "drizzle-orm";
import { audit } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { executionSteps, workflows, workflowVersions } from "../../db/schema/index.ts";
import { cancel } from "../../execution/abort.ts";
import { runExecution } from "../../execution/engine.ts";
import { maybeOffload } from "../../execution/offload.ts";
import { logger } from "../../logging/logger.ts";
import { can } from "../../rbac/evaluator.ts";
import { WorkflowDefSchema } from "../../workflows/types.ts";
import { MCP_OFFLOAD_CHAR_CAP } from "../types.ts";
import {
  CONVERSATION_TOOL_PREFIX,
  handleConversationTool,
  listConversationTools,
} from "./conversations.ts";

const TOOL_PREFIX = "wf.";
const PROGRESS_POLL_MS = 250;

function emptyObjectSchema(): Tool["inputSchema"] {
  return { type: "object", properties: {} };
}

function toInputSchema(raw: unknown): Tool["inputSchema"] {
  // The workflow `input_schema` field is persisted as-is (raw JSON
  // Schema). When it already looks like an object schema, pass it
  // through; otherwise fall back to the empty shape so the SDK's zod
  // validator keeps smiling.
  if (
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    (raw as { type?: unknown }).type === "object"
  ) {
    return raw as Tool["inputSchema"];
  }
  return emptyObjectSchema();
}

interface ListToolsParams {
  db: Db;
  principal: ResolvedPrincipal;
}

async function listWorkflowTools({ db, principal }: ListToolsParams): Promise<Tool[]> {
  const rows = await db
    .select({
      id: workflows.id,
      slug: workflows.slug,
      name: workflows.name,
      current_version_id: workflows.current_version_id,
    })
    .from(workflows)
    .where(and(eq(workflows.tenant_id, principal.tenant_id), isNull(workflows.deleted_at)))
    .orderBy(asc(workflows.created_at));

  const out: Tool[] = [];
  for (const row of rows) {
    if (!row.current_version_id) continue;
    // Respect per-key allowed_workflows scope when set.
    if (
      principal.allowed_workflows &&
      principal.allowed_workflows !== "all" &&
      !principal.allowed_workflows.includes(row.id)
    ) {
      continue;
    }
    let description = row.name;
    let inputSchema: Tool["inputSchema"] = emptyObjectSchema();
    const versionRows = await db
      .select({ dag: workflowVersions.dag })
      .from(workflowVersions)
      .where(eq(workflowVersions.id, row.current_version_id))
      .limit(1);
    const dag = versionRows[0]?.dag;
    if (dag) {
      const parsed = WorkflowDefSchema.safeParse(dag);
      if (parsed.success) {
        if (parsed.data.description) description = parsed.data.description;
        inputSchema = toInputSchema(parsed.data.input_schema);
      }
    }
    out.push({
      name: `${TOOL_PREFIX}${row.slug}`,
      description,
      inputSchema,
    });
  }
  return out;
}

async function resolveWorkflowBySlug(
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

interface ProgressNotifier {
  send: (progress: number, total: number, message: string) => Promise<void>;
}

function startProgressBridge(
  db: Db,
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
        .where(eq(executionSteps.execution_id, execution_id))
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
    } catch {
      // swallow — the bridge is best-effort.
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

export interface RegisterToolsParams {
  server: Server;
  db: Db;
  principal: ResolvedPrincipal;
  transport: "http" | "stdio";
}

export function registerToolsCapability(p: RegisterToolsParams): void {
  const { server, db, principal } = p;

  server.registerCapabilities({ tools: { listChanged: false } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await listWorkflowTools({ db, principal });
    return { tools: [...tools, ...listConversationTools()] };
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

      if (name.startsWith(CONVERSATION_TOOL_PREFIX)) {
        const result = await handleConversationTool({
          db,
          principal,
          name,
          args: args as Record<string, unknown>,
        });
        logger.info({
          module: "mcp",
          action: "mcp.tool.result",
          msg: "mcp conversation tool call completed",
          tool: name,
          duration_ms: Date.now() - started,
          is_error: result.isError,
        });
        return {
          isError: result.isError,
          content: result.content.map((c) => ({ type: "text" as const, text: c.text })),
        };
      }

      if (!name.startsWith(TOOL_PREFIX)) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `unknown tool: ${name}` }],
        };
      }
      const slug = name.slice(TOOL_PREFIX.length);
      const wf = await resolveWorkflowBySlug(db, principal.tenant_id, slug);
      if (!wf) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `workflow not found: ${slug}` }],
        };
      }

      // Centralized RBAC evaluator — resolves built-in admin,
      // resource grants, groups, role_permissions, and the portal
      // token allowlist in one call.
      const decision = await can(db, {
        tenant_id: principal.tenant_id,
        principal,
        permission: "workflow:run",
        resource: { type: "workflow", id: wf.id },
      });
      if (!decision.allow) {
        // Preserve the legacy reason string for allowlist denials so
        // the existing audit-log + error-message contracts keep
        // working. Other denials surface as a generic reason.
        const allowlistViolation =
          principal.provider === "portal_token" || Array.isArray(principal.allowed_workflows);
        const auditReason = allowlistViolation
          ? "mcp_workflow_not_in_allowlist"
          : (decision.reason ?? "mcp_permission_denied");
        const errMessage = allowlistViolation
          ? "workflow_not_in_allowlist"
          : (decision.reason ?? "permission_denied");
        audit(
          {
            tenant_id: principal.tenant_id,
            actor_type: principal.kind === "user" ? "user" : "system",
            actor_id: principal.id,
            action: AuditAction.POLICY_DENIED,
            resource_type: "workflow",
            resource_id: wf.id,
            result: "denied",
            reason: auditReason,
            metadata: {
              tool: name,
              via: "mcp",
              provider: principal.provider,
              permission: "workflow:run",
            },
          },
          db,
        );
        logger.warn({
          module: "mcp",
          action: "mcp.tool.denied",
          msg: "mcp tools/call denied by RBAC evaluator",
          tool: name,
          workflow_id: wf.id,
          principal_id: principal.id,
          reason: decision.reason,
        });
        const err = new Error(errMessage) as Error & { code?: number };
        err.code = -32001;
        throw err;
      }

      // Work out how many steps the current version has for the
      // progress bridge's total estimate.
      let totalSteps = 1;
      try {
        const wfRows = await db
          .select({ current_version_id: workflows.current_version_id })
          .from(workflows)
          .where(eq(workflows.id, wf.id))
          .limit(1);
        const vId = wfRows[0]?.current_version_id ?? null;
        if (vId) {
          const vRows = await db
            .select({ dag: workflowVersions.dag })
            .from(workflowVersions)
            .where(eq(workflowVersions.id, vId))
            .limit(1);
          const parsed = vRows[0]?.dag ? WorkflowDefSchema.safeParse(vRows[0].dag) : null;
          if (parsed?.success) totalSteps = parsed.data.steps.length;
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
        workflow_id: wf.id,
        input: args,
        options: {
          request_source: "mcp",
          signal: abortController.signal,
          trace_id: null,
          principal,
          execution_mode,
        },
      });

      // Poll the executions table briefly to pick up the id (createExecution
      // is called synchronously inside runExecution's first tick, so we kick
      // off the bridge on the next microtask).
      void Promise.resolve().then(async () => {
        // Small delay so the executions row lands before the first poll.
        setTimeout(async () => {
          try {
            const { executions } = await import("../../db/schema/index.ts");
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
                state.bridge = startProgressBridge(db, latest.id, totalSteps, notifier);
              }
            }
          } catch {
            // ignore
          }
        }, 25).unref?.();
      });

      try {
        const result = await runPromise;
        state.bridge?.stop();
        // Final progress frame @ 1.0.
        if (progressToken !== undefined && progressToken !== null) {
          await notifier.send(1, 1, "completed").catch(() => {});
        }
        // Offload if oversize.
        const serialized = JSON.stringify(result.output ?? null);
        if (serialized.length > MCP_OFFLOAD_CHAR_CAP) {
          const off = await maybeOffload(db, {
            tenant_id: principal.tenant_id,
            execution_id: result.execution_id,
            step_id: null,
            result: result.output,
          });
          const envelope = {
            kind: "offloaded" as const,
            uri: off.storage_uri,
            preview: off.preview,
            execution_id: result.execution_id,
            status: result.status,
          };
          const bytes = JSON.stringify(envelope).length;
          logger.info({
            module: "mcp",
            action: "mcp.tool.result",
            msg: "mcp tool call offloaded",
            tool: name,
            duration_ms: Date.now() - started,
            bytes,
            execution_id: result.execution_id,
          });
          return {
            isError: result.status !== "succeeded",
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(envelope),
              },
            ],
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
        });
        return {
          isError: result.status !== "succeeded",
          content: [{ type: "text" as const, text }],
        };
      } catch (err) {
        state.bridge?.stop();
        if (state.executionId) cancel(state.executionId);
        const message = err instanceof Error ? err.message : String(err);
        logger.error({
          module: "mcp",
          action: "mcp.tool.error",
          msg: "mcp tool call failed",
          tool: name,
          error: message,
        });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `error: ${message}` }],
        };
      }
    },
  );
}
