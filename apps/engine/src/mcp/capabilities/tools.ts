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
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { getConfig } from "../../config/loader.ts";
import type { Db } from "../../db/client.ts";
import { executionSteps, workflows, workflowVersions } from "../../db/schema/index.ts";
import { cancel } from "../../execution/abort.ts";
import { runExecution } from "../../execution/engine.ts";
import { maybeOffload } from "../../execution/offload.ts";
import { logger } from "../../logging/logger.ts";
import { globalEmitter } from "../../pubsub/emitter.ts";
import type { EventEnvelope } from "../../pubsub/types.ts";
import { getUnifiedRegistry } from "../../tools/index.ts";
import type { ConfirmEnvelope, ToolInvocation } from "../../tools/types.ts";
import { listWorkflowToolsForTenant } from "../../workflows/catalog.ts";
import { gateWorkflowRunRbac } from "../../workflows/rbac.ts";
import { WorkflowDefSchema } from "../../workflows/types.ts";
import { type ConfirmResolver, callToolViaDispatcher, listToolsViaRegistry } from "../adapter.ts";
import { createElicitationBridge } from "../elicitation/bridge.ts";
import { toMcpErrorText } from "../error-adapter.ts";
import { MCP_CORE_TOOL_NAMES, type McpMode, modeFlags, resolveMcpMode } from "../mode-resolver.ts";
import { MCP_OFFLOAD_CHAR_CAP } from "../types.ts";
import {
  CONVERSATION_TOOL_PREFIX,
  handleConversationTool,
  listConversationTools,
} from "./conversations.ts";
import { raceInlineRun } from "./inline-timeout.ts";
import { buildWorkflowToolAnnotations, buildWorkflowToolMeta } from "./tool-meta.ts";

const TOOL_PREFIX = "wf_";
const PROGRESS_POLL_MS = 250;
// Conservative budget for the COMBINED tools/list schema. Strict MCP clients
// cap total tool-schema size and silently drop tools past it (a real one we
// measured degrades around this point, surfacing a frontend storage-quota
// error). General, not tuned to any one vendor: we log the estimate on every
// tools/list and warn past the budget so the operator sees the risk.
const SCHEMA_TOKEN_BUDGET = 5000;
// ~4 chars/token is the standard rough estimate for English/JSON.
const CHARS_PER_TOKEN_EST = 4;
// Upper bound on how long a `wf_<slug>` run blocks the tools/call response, so
// a slow run can't blow past a client's request timeout (strict clients abort
// tool calls around ~60s). Past this window we stop blocking and hand back a
// polling handle (execution_id → get_execution) while the run finishes in the
// background. Fast runs (the common case) resolve inside this and return
// inline unchanged. Applies to every client/transport.
const WF_INLINE_TIMEOUT_MS = 50_000;
// Default size of the per-workflow `wf_` palette; matches the converse cap.
const DEFAULT_PALETTE_LIMIT = 40;
// Floor the budget-fit cascade trims the palette to before falling back to
// schema compression. The trimmed-out workflows stay reachable via
// `find_workflow` / `run_workflow(slug)` (search-first), so this is a
// preloading bound, not a functional limit.
const MIN_PALETTE_LIMIT = 10;
// Prose caps applied only when the budget-fit cascade enables compression.
const MAX_TOOL_DESC_CHARS = 220;
const MAX_SCHEMA_DESC_CHARS = 80;
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

/**
 * Fallback responder tool for MCP clients that do NOT advertise the
 * `elicitation` capability. A `confirm_before_execution` gate returns a
 * `_meta.subkit.confirm` envelope to such clients; the model then approves
 * the paused call by invoking this tool with the original `tool`,
 * `arguments`, and `confirm_id` (the envelope's `tool_call_id`).
 *
 * Reality check (verified via runtime logs + client capability research):
 * the hosted flagship clients do NOT advertise `elicitation`, so they DO see
 * this tool and confirm through it (model-driven, gated by the dispatcher's
 * APPROVAL_REQUESTED check). The in-band `elicitation/create` path is
 * reserved for clients that advertise the elicitation capability, which then
 * never see this tool.
 */
const CONFIRM_TOOL_CALL_NAME = "confirm_tool_call";
const CONFIRM_TOOL_CALL_TOOL: Tool = {
  name: CONFIRM_TOOL_CALL_NAME,
  description:
    "Approve a tool call that paused for confirmation (status:needs_confirm). Re-runs the " +
    "named tool with the operator's approval. Pass the same `tool` and `arguments` from the " +
    "confirm envelope and set `confirm_id` to its `tool_call_id`.",
  inputSchema: {
    type: "object",
    properties: {
      tool: { type: "string", description: "Name of the paused tool to approve and run." },
      arguments: {
        type: "object",
        description: "The original arguments from the confirm envelope.",
      },
      confirm_id: {
        type: "string",
        description: "The `tool_call_id` from the confirm envelope (joins the approval audit).",
      },
    },
    required: ["tool", "confirm_id"],
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
};

/** One-line operator prompt for an in-band confirm elicitation. */
function buildConfirmPrompt(confirm: ConfirmEnvelope): string {
  const reason = confirm.reason.replace(/_/g, " ");
  let argsPreview = "";
  try {
    const json = JSON.stringify(confirm.args);
    argsPreview = json.length > 300 ? `${json.slice(0, 300)}…` : json;
  } catch {
    argsPreview = "(unserializable)";
  }
  return `Approve ${confirm.tool} (${reason})? Arguments: ${argsPreview}`;
}

/** Single-field confirm schema accepted by MCP `elicitation/create` form mode. */
const CONFIRM_ELICIT_SCHEMA = {
  type: "object" as const,
  properties: {
    confirm: {
      type: "boolean" as const,
      title: "Proceed?",
      description: "Confirm to run the call; decline to cancel.",
    },
  },
  required: ["confirm"],
};

interface ListToolsParams {
  db: Db;
  principal: ResolvedPrincipal;
  limit?: number;
}

async function listWorkflowTools({ db, principal, limit }: ListToolsParams): Promise<Tool[]> {
  const catalog = await listWorkflowToolsForTenant({
    db,
    principal,
    ...(limit !== undefined ? { limit } : {}),
  });
  return catalog.map((entry) => ({
    name: `${TOOL_PREFIX}${entry.slug}`,
    // Frame the tool as an executable action, not a passive description.
    // Without this, a workflow description like "Lists all Test Plan issues…"
    // reads as documentation and the model re-derives the query with
    // call_connector instead of running the saved workflow. The "prefer this
    // over re-deriving" nudge closes that gap.
    description: describeWorkflowTool(entry),
    inputSchema: entry.inputSchema as Tool["inputSchema"],
    annotations: buildWorkflowToolAnnotations(),
    _meta: buildWorkflowToolMeta(),
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

/** Estimate the combined tools/list schema token cost (~4 chars/token). */
export function estimateCatalogTokens(tools: Tool[]): number {
  return Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN_EST);
}

/** Recursively trim prose-only fields from a JSON schema without touching any
 *  structural key (`type`, `required`, `properties`, `items`, `enum`, …). Only
 *  `description` strings are capped and `examples`/`$comment` (pure prose,
 *  ignored by validators) are dropped — so a compressed schema still validates
 *  every input the original did. */
function compressSchemaProse(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(compressSchemaProse);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "examples" || key === "$comment") continue;
    if (key === "description" && typeof value === "string") {
      out[key] =
        value.length > MAX_SCHEMA_DESC_CHARS
          ? `${value.slice(0, MAX_SCHEMA_DESC_CHARS - 1).trimEnd()}…`
          : value;
      continue;
    }
    out[key] = compressSchemaProse(value);
  }
  return out;
}

/** Shrink a tool's token footprint by trimming prose only — its callable
 *  contract (name, inputSchema structure, required fields) is unchanged. */
export function compressToolSchema(tool: Tool): Tool {
  const description =
    tool.description && tool.description.length > MAX_TOOL_DESC_CHARS
      ? `${tool.description.slice(0, MAX_TOOL_DESC_CHARS - 1).trimEnd()}…`
      : tool.description;
  return {
    ...tool,
    ...(description !== undefined ? { description } : {}),
    inputSchema: compressSchemaProse(tool.inputSchema) as Tool["inputSchema"],
  };
}

interface AssembleTierParams {
  principal: ResolvedPrincipal;
  readOnly: boolean;
  mode: McpMode;
  paletteLimit: number;
  compress: boolean;
  elicitationCapable: boolean;
  /** Full `wf_` palette, fetched once; sliced to `paletteLimit` per tier. */
  fullPalette: Tool[];
}

// Tool whose early position matters when a strict client truncates the
// manifest at its own token limit: it anchors the search-first authoring entry
// point right after the core + workflow palette.
const CONVERSATION_START_TOOL_NAME = "conversation_start";

/** Essentials-first priority. Strict clients that silently drop tools tend to
 *  truncate the tail of the manifest, so we lead with what every client needs:
 *  the search-first core, then the workflow palette, then the authoring entry
 *  point, then everything else. A stable sort preserves intra-bucket order. */
function essentialsRank(tool: Tool): number {
  if (MCP_CORE_TOOL_NAMES.has(tool.name)) return 0;
  if (tool.name.startsWith(TOOL_PREFIX)) return 1;
  if (tool.name === CONVERSATION_START_TOOL_NAME) return 2;
  return 3;
}

function orderEssentialsFirst(tools: Tool[]): Tool[] {
  return tools
    .map((tool, i) => ({ tool, i }))
    .sort((a, b) => essentialsRank(a.tool) - essentialsRank(b.tool) || a.i - b.i)
    .map((e) => e.tool);
}

/** Assemble one catalog tier (in-memory; no DB). The `wf_` palette is sliced
 *  from the pre-fetched full list, the registry + conversation tools follow the
 *  mode, and `confirm_tool_call` is appended for non-elicitation clients so it
 *  is always part of the measured floor. The result is ordered essentials-first
 *  so a strict client that truncates keeps the tools that matter. */
export function assembleTier(p: AssembleTierParams): Tool[] {
  const flags = modeFlags(p.mode, p.readOnly);
  const tools: Tool[] = [];
  tools.push(...p.fullPalette.slice(0, p.paletteLimit));
  tools.push(
    ...listToolsViaRegistry({
      principal: p.principal,
      mcpMode: p.mode,
      readOnly: !flags.showTenantWrites,
    }),
  );
  if (flags.showConversationTools) tools.push(...listConversationTools());
  if (!p.elicitationCapable) tools.push(CONFIRM_TOOL_CALL_TOOL);
  const compressed = p.compress ? tools.map(compressToolSchema) : tools;
  return orderEssentialsFirst(compressed);
}

export interface CatalogFitResult {
  tools: Tool[];
  estTokensBefore: number;
  estTokensAfter: number;
  mode: McpMode;
  paletteLimit: number;
  compressed: boolean;
}

/** Shrink the catalog toward the schema-token budget without ever dropping a
 *  named tool or stepping the mode — one general path for every client/mode.
 *
 *  Non-destructive levers, in order: shrink the `wf_` palette to its Top-N (the
 *  trimmed workflows stay reachable via find_workflow / run_workflow(slug)),
 *  then compress schema prose. We never drop a named tool (that would break
 *  list/resolve parity and the authoring surface), so a rich authoring/admin
 *  catalog can legitimately stay above the budget — capable clients (claude.ai,
 *  sk-cli) handle it, and assembleTier orders the result essentials-first so a
 *  strict client that truncates still keeps the core + palette + authoring
 *  entry point. The product surface fits under the budget outright. */
export function fitCatalogToBudget(
  base: Omit<AssembleTierParams, "mode" | "paletteLimit" | "compress"> & { initialMode: McpMode },
): CatalogFitResult {
  const mode = base.initialMode;
  let paletteLimit = DEFAULT_PALETTE_LIMIT;
  let compress = false;
  let tools = assembleTier({ ...base, mode, paletteLimit, compress });
  const estTokensBefore = estimateCatalogTokens(tools);
  let est = estTokensBefore;
  while (est > SCHEMA_TOKEN_BUDGET) {
    if (paletteLimit > MIN_PALETTE_LIMIT) paletteLimit = MIN_PALETTE_LIMIT;
    else if (!compress) compress = true;
    else break; // non-destructive levers exhausted — keep every named tool
    tools = assembleTier({ ...base, mode, paletteLimit, compress });
    est = estimateCatalogTokens(tools);
  }
  return { tools, estTokensBefore, estTokensAfter: est, mode, paletteLimit, compressed: compress };
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

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // The catalog is assembled per mcp mode, then trimmed to fit the strict
    // tools/list token budget (fitCatalogToBudget) so strict clients never
    // silently drop tools. Sources per tier:
    //   - listWorkflowTools     — wf_<slug> per-workflow tools (Top-N palette).
    //   - listToolsViaRegistry  — unified registry: static (authenticate,
    //                             list_recipes, self_healing.scan in admin)
    //                             plus every visible conversation tool under
    //                             its bare name.
    //   - listConversationTools — MCP-only conversation.* session tools.
    //   - CONFIRM_TOOL_CALL_TOOL — appended for non-elicitation clients.
    // The trimmed long tail stays reachable via find_workflow /
    // run_workflow(slug) (search-first) — nothing becomes unreachable.
    const initialMode = resolveMcpMode(principal);
    // Surface the confirm responder ONLY for clients without MCP elicitation.
    // The hosted flagship clients do NOT advertise elicitation, so they receive
    // it and confirm through it; only clients that advertise elicitation are
    // prompted in-band and skip it.
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
      elicitationCapable,
      fullPalette,
    });
    // Defense-in-depth: the search-first floor must survive the trim. The
    // leanest tier preserves it by construction (product allow-list +
    // static + appended confirm), but assert it so a future regression is
    // loud rather than silent. confirm_tool_call is core only for
    // non-elicitation clients (elicitation-capable ones confirm in-band).
    const presentNames = new Set(fit.tools.map((t) => t.name));
    const missingCore = [...MCP_CORE_TOOL_NAMES].filter(
      (coreName) =>
        !presentNames.has(coreName) && !(coreName === CONFIRM_TOOL_CALL_NAME && elicitationCapable),
    );
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
    return { tools: fit.tools };
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
        const callMeta = request.params._meta as Record<string, unknown> | undefined;
        const invocation: ToolInvocation = {
          surface: "mcp",
          name,
          args: args as Record<string, unknown>,
          ...(callMeta ? { meta: callMeta } : {}),
        };
        // In-band human-in-the-loop: when the client advertises
        // elicitation, resolve a `needs_confirm` gate by prompting the
        // operator via `elicitation/create` rather than handing back an
        // envelope the model cannot satisfy (it cannot set `_meta`).
        const bridge = createElicitationBridge(server, extra);
        const confirmResolver: ConfirmResolver | undefined = bridge.capabilities.form
          ? async (confirm: ConfirmEnvelope): Promise<boolean> => {
              const res = await bridge.elicitForm({
                message: buildConfirmPrompt(confirm),
                requestedSchema: CONFIRM_ELICIT_SCHEMA,
              });
              return res.action === "accept" && res.content?.confirm === true;
            }
          : undefined;
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
            ...(execId
              ? { _meta: { subkit: { execution: { id: execId, status: "running" } } } }
              : {}),
          };
        }
        const result = outcome.result;
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
