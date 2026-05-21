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
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { getConfig } from "../../config/loader.ts";
import { listTools as listConversationToolsRegistry } from "../../conversations/tools/index.ts";
import type { Db } from "../../db/client.ts";
import { executionSteps, workflows, workflowVersions } from "../../db/schema/index.ts";
import { cancel } from "../../execution/abort.ts";
import { runExecution } from "../../execution/engine.ts";
import { maybeOffload } from "../../execution/offload.ts";
import { logger } from "../../logging/logger.ts";
import { can } from "../../rbac/evaluator.ts";
import { getUnifiedRegistry } from "../../tools/index.ts";
import type { ToolInvocation } from "../../tools/types.ts";
import { synthesizeInputSchema } from "../../workflows/input-schema-synth.ts";
import { WorkflowDefSchema } from "../../workflows/types.ts";
import { callToolViaDispatcher, listToolsViaRegistry } from "../adapter.ts";
import { toMcpErrorText } from "../error-adapter.ts";
import { modeFlags, resolveMcpMode } from "../mode-resolver.ts";

import { MCP_OFFLOAD_CHAR_CAP } from "../types.ts";
import {
  CONVERSATION_TOOL_PREFIX,
  handleConversationTool,
  listConversationTools,
} from "./conversations.ts";
import { gateTenantToolCall } from "./policy-gate.ts";
import { handleTenantTool, listTenantTools, TENANT_TOOL_PREFIX } from "./tenant-tools.ts";
import { buildWorkflowToolMeta } from "./tool-meta.ts";

const TOOL_PREFIX = "wf_";
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
  // Product-catalog rule: only workflows flagged `is_tool=true` are
  // exposed as MCP tools. Drafts (no current_version_id) never show up,
  // regardless of the flag.
  const rows = await db
    .select({
      id: workflows.id,
      slug: workflows.slug,
      name: workflows.name,
      current_version_id: workflows.current_version_id,
      is_tool: workflows.is_tool,
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.tenant_id, principal.tenant_id),
        isNull(workflows.deleted_at),
        eq(workflows.is_tool, true),
      ),
    )
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
      .where(
        and(
          eq(workflowVersions.tenant_id, principal.tenant_id),
          eq(workflowVersions.id, row.current_version_id),
        ),
      )
      .limit(1);
    const dag = versionRows[0]?.dag;
    if (dag) {
      const parsed = WorkflowDefSchema.safeParse(dag);
      if (parsed.success) {
        if (parsed.data.description) description = parsed.data.description;
        if (parsed.data.input_schema) {
          inputSchema = toInputSchema(parsed.data.input_schema);
        } else {
          const synth = synthesizeInputSchema(parsed.data);
          if (synth) inputSchema = synth as Tool["inputSchema"];
        }
      }
    }
    out.push({
      name: `${TOOL_PREFIX}${row.slug}`,
      description,
      inputSchema,
      _meta: buildWorkflowToolMeta(),
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

export interface RegisterToolsParams {
  server: Server;
  db: Db;
  principal: ResolvedPrincipal;
  transport: "http" | "stdio";
}

export function registerToolsCapability(p: RegisterToolsParams): void {
  const { server, db, principal } = p;

  server.registerCapabilities({ tools: { listChanged: false } });

  // Write-tools inside the tenant.* family are additionally gated at
  // call time by `gateTenantToolCall`. The env var below forces a strictly
  // read-only MCP deployment — overriding mode-based visibility.
  let readOnly = false;
  try {
    readOnly = getConfig().mcp.read_only;
  } catch {
    /* loader not initialised */
  }
  const allowTenantWrites = !readOnly;

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // The catalog surface is shaped by the principal's mcp mode:
    //   • product   — saved workflows + authenticate (default)
    //   • authoring — adds conversation.* + tenant reads
    //   • admin     — adds tenant.* writes
    //
    // Sources, in priority order:
    //   - listWorkflowTools         — wf.<slug> per-workflow tools.
    //   - listToolsViaRegistry      — unified registry: static
    //                                 (authenticate, list_recipes,
    //                                 self_healing.scan in admin) plus
    //                                 every visible conversation tool
    //                                 surfaced under its bare name.
    //   - listConversationTools     — MCP-only session-management tools
    //                                 under the conversation.* prefix.
    //   - listTenantTools           — backward-compat `tenant.*` prefix
    //                                 aliases for conversation tools;
    //                                 retained for existing MCP clients.
    const mode = resolveMcpMode(principal);
    const flags = modeFlags(mode, readOnly);
    const tools: Tool[] = [];
    tools.push(...(await listWorkflowTools({ db, principal })));
    tools.push(
      ...listToolsViaRegistry({
        principal,
        mcpMode: mode,
        readOnly: !flags.showTenantWrites,
      }),
    );
    if (flags.showConversationTools) tools.push(...listConversationTools());
    if (flags.showTenantReads || flags.showTenantWrites) {
      tools.push(...listTenantTools({ allowWrites: flags.showTenantWrites }));
    }
    return { tools };
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

      // Every named MCP tool (authenticate, list_recipes,
      // self_healing.scan + the four conversation duplicates) and every
      // bare-name conversation tool routes through the unified dispatcher
      // in apps/engine/src/tools/. wf.<slug> and the conversation.* /
      // tenant.* prefix proxies remain on the legacy path below because
      // they are surface-specific operational concerns, not LLM tool
      // palette items.
      const mcpModeForCall = resolveMcpMode(principal);
      const readOnlyForCall = !modeFlags(mcpModeForCall, readOnly).showTenantWrites;
      const probeEntry = getUnifiedRegistry().get(name, {
        surface: "mcp",
        mcpMode: mcpModeForCall,
        readOnly: readOnlyForCall,
      });
      if (probeEntry) {
        const callMeta = request.params._meta as Record<string, unknown> | undefined;
        const invocation: ToolInvocation = {
          surface: "mcp",
          name,
          args: args as Record<string, unknown>,
          ...(callMeta ? { meta: callMeta } : {}),
        };
        const response = await callToolViaDispatcher({
          db,
          principal,
          mcpMode: mcpModeForCall,
          readOnly: readOnlyForCall,
          invocation,
        });
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
        const result = await handleConversationTool({
          db,
          principal,
          name,
          args: args as Record<string, unknown>,
          ...(permissionMode ? { permission_mode: permissionMode } : {}),
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

      if (name.startsWith(TENANT_TOOL_PREFIX)) {
        // MCP progress-token bridge: when the caller supplies a
        // progressToken, send start + completion notifications so the
        // client can show a spinner. Tools that emit finer-grained
        // progress signal it via `ctx.onLog` (see sdk-wrap); the
        // handler doesn't have access to that stream today, but the
        // boundary frames give clients a deterministic start/stop.
        const notifyProgress = progressToken
          ? async (progress: number, message: string) => {
              try {
                await extra.sendNotification({
                  method: "notifications/progress",
                  params: { progressToken, progress, total: 1, message },
                });
              } catch {
                // best-effort — notifier errors never fail the tool call
              }
            }
          : undefined;
        // Policy gate: confirm_before_execution tools return a pending
        // envelope on the first call; the client re-issues with
        // _meta.sk_confirm=true after operator approval.
        const bareToolName = name.slice(TENANT_TOOL_PREFIX.length);
        const toolDef = listConversationToolsRegistry().find((t) => t.name === bareToolName);
        const rawTenantArgs = args as Record<string, unknown>;
        if (toolDef) {
          const gate = await gateTenantToolCall({
            tool: bareToolName,
            category: toolDef.category,
            args: rawTenantArgs,
            meta: request.params._meta as Record<string, unknown> | undefined,
            principal,
            db,
          });
          if (gate.kind === "pending") {
            const envelopeText = JSON.stringify(gate.envelope);
            logger.info({
              module: "mcp",
              action: "mcp.tool.pending",
              msg: "mcp tenant tool call requires confirmation",
              tool: name,
              tool_call_id: gate.envelope.tool_call_id,
              duration_ms: Date.now() - started,
            });
            return {
              isError: false,
              content: [{ type: "text" as const, text: envelopeText }],
            };
          }
        }
        // Strip the confirmation marker so the tool's strict zod
        // schema doesn't reject it as an unknown property.
        const { __policy_confirmed: _confirmFlag, ...tenantArgs } = rawTenantArgs;
        if (notifyProgress) await notifyProgress(0, `starting ${name}`);
        const result = await handleTenantTool({
          db,
          principal,
          name,
          args: tenantArgs,
          allowWrites: allowTenantWrites,
          ...(notifyProgress ? { onProgress: notifyProgress } : {}),
        });
        if (result) {
          if (notifyProgress) await notifyProgress(1, `done ${name}`);
          logger.info({
            module: "mcp",
            action: "mcp.tool.result",
            msg: "mcp tenant tool call completed",
            tool: name,
            duration_ms: Date.now() - started,
            is_error: result.isError,
            progress_token: progressToken ?? null,
          });
          return {
            isError: result.isError,
            content: result.content.map((c) => ({ type: "text" as const, text: c.text })),
          };
        }
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
        // Use auditAwait so the deny audit row is committed BEFORE the
        // MCP response reaches the client. Without this, portal-token
        // end-user tests that inspect the audit table immediately after
        // receiving the deny race the fire-and-forget `audit()` write
        // and occasionally see zero rows on CI's slower ubuntu runner.
        await auditAwait(
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
        source: { kind: "saved", workflow_id: wf.id },
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
        const result = await runPromise;
        state.bridge?.stop();
        // Final progress frame @ 1.0.
        if (progressToken !== undefined && progressToken !== null) {
          await notifier.send(1, 1, "completed").catch(() => {});
        }
        // When a run produced non-fatal warnings (e.g. jsonata
        // `unresolved_identifier`), wrap the output so the MCP client
        // sees them alongside the payload. No wrapping when clean.
        const hasWarnings = (result.warnings?.length ?? 0) > 0;
        const rawBody: unknown = hasWarnings
          ? { output: result.output ?? null, warnings: result.warnings }
          : (result.output ?? null);
        // Offload if oversize. Warnings travel with the envelope.
        const serialized = JSON.stringify(rawBody);
        if (serialized.length > MCP_OFFLOAD_CHAR_CAP) {
          const off = await maybeOffload(db, {
            tenant_id: principal.tenant_id,
            execution_id: result.execution_id,
            step_id: null,
            result: result.output,
          });
          // MCP `resource_link` content block (2025-03 spec). The previous
          // text-encoded JSON envelope forced clients to parse a string
          // field to discover the fixture URI; LLM agents (e.g. codex)
          // rarely follow such pointers without explicit instruction.
          // `resource_link` is the native protocol affordance: compliant
          // clients can auto-fetch, surface to the user, or expose the
          // URI as a follow-up call. Pairs with the `fixture://` reader
          // in apps/engine/src/mcp/capabilities/resources.ts.
          const summaryLines: string[] = [
            `Execution ${result.execution_id} ${result.status}; result is ${off.size_bytes} bytes (offloaded — inline cap is ${MCP_OFFLOAD_CHAR_CAP} bytes).`,
          ];
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
            isError: result.status !== "succeeded",
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
        return {
          isError: result.status !== "succeeded",
          content: [{ type: "text" as const, text }],
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
