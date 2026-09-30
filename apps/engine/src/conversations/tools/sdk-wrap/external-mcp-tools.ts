// Synthetic `mcp_<ns>__<entry>` tools for the chat palette.
//
// Every active external MCP server a tenant registered has its surface
// merged into the chat LLM's palette so a user message that names a
// remote tool dispatches in ONE tool call. The per-tenant Client pool
// (`apps/engine/src/mcp/client/pool.ts`) owns the live connections,
// manifests, credentials, and result truncation; this module converts
// each palette entry into an AI SDK `Tool` whose `execute` follows the
// EXACT side-effect sequence the in-repo wrappers use:
//
//   1. acquire the `signals.toolChain` mutex (serialise the turn)
//   2. enforce `mcp_external_tool:invoke` (RBAC `can`)
//   3. resolve approval through the ONE confirm gate (`tools/policy.ts`)
//      and the durable approval handle (`tools/approval.ts`) every other
//      surface uses — a pause persists the args, the confirmed re-issue
//      carries only the `confirm_id` and the engine replays them
//   4. on confirm, call `pool.invokeRemoteTool`
//   5. PERSIST THE FULL remote content into the tool-call row (the
//      remote payload is verbatim — no wall-clock / random — so replay
//      is deterministic), and feed only a TRUNCATED view to the model
//   6. emit `tool_call_start` / `tool_call_end` / `tool_result`
//
// Tool name grammar is `mcp_<connector_slug>__<entry>`. The slug half is
// `__`-free by a DB CHECK, so the `__` separator is an unambiguous split
// point; `buildMcpToolName` owns the grammar and REFUSES a pair it cannot
// address rather than truncating one. The `mcp_` prefix is what the policy
// resolver keys on (`isDangerousTool` + `getApprovalMode`) to force
// "asks before running" under auto/ask/plan.
//
// AN ENTRY IS NOT ALWAYS A REMOTE TOOL. Each palette entry is a
// `PaletteOperationSpec`: a name, a schema, and the ONE remote operation
// it issues. Remote tools supply one each; the read-only resource and
// prompt adapters (`external-mcp-readonly.ts`) supply the rest. They share
// this pipeline deliberately — the mutex, the RBAC check, the confirm
// gate, the persisted raw payload and the truncated model view are the
// governance, and a second copy of them for reads is a second place for
// them to drift.
//
// WHAT THE SERVER SAYS vs WHAT THE ENGINE DOES. A remote's `annotations`
// reach the model in the entry's description and the audit trail, and they
// reach NO gate: every `tools/call` confirms, whatever the server claims
// about itself, unless an operator listed that tool on the connector as
// running without a question. `classifyMcpToolSideEffect` carries that rule.

import { classifyMcpToolSideEffect } from "@shared/index.ts";
import { jsonSchema, type Tool, tool } from "ai";
import { recordMcpExternalToolPaletteAssemblyFailed } from "../../../audit/recorders/index.ts";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import { buildMcpToolName, mcpEgressInput } from "../../../connectors/drivers/mcp.ts";
import { withEgressAudit } from "../../../connectors/egress.ts";
import { readMcpToolsWithoutConfirmation } from "../../../connectors/mcp-tool-trust.ts";
import type { Db } from "../../../db/client.ts";
import { logger } from "../../../logging/logger.ts";
import {
  getTenantMcpTools,
  invokeRemoteTool,
  type RemoteToolDescriptor,
  type TenantMcpToolSet,
} from "../../../mcp/client/pool.ts";
import type { RemoteCall } from "../../../mcp/client/remote-call.ts";
import { recordConversationToolCall } from "../../../observability/instrumentation.ts";
import { can } from "../../../rbac/evaluator.ts";
import {
  consumeApproval,
  recordApprovalApproved,
  requestApproval,
  stripConfirmMarkers,
} from "../../../tools/approval.ts";
import {
  confirmIdFromArgs,
  isConfirmedRequest,
  policyDecide,
  withConfirmMarkerProperties,
} from "../../../tools/policy.ts";
import { createElicitation } from "../../elicitations.ts";
import { appendMessage, insertToolCall, updateToolCallOutput } from "../../persist.ts";
import type { TurnEvent } from "../../types.ts";
import { withoutApprovalHandle } from "../ask-user/commit-intent.ts";
import type { ToolContext } from "../index.ts";
import { truncateForLlm } from "../truncate.ts";
import { readOnlyPaletteSpecs } from "./external-mcp-readonly.ts";
import { jsonSafeModelOutput } from "./json-safe-output.ts";
import type { TurnSignals, WrappedToolOutput } from "./state.ts";

/**
 * One palette entry, reduced to what the governed pipeline needs: what to
 * call it, what to tell the model, what arguments it takes, and which ONE
 * remote operation it issues.
 *
 * `toCall` returns a result rather than throwing so a malformed argument
 * is answered as a tool error the model can correct, and — because it runs
 * BEFORE the confirm gate — a human is never asked to approve a call that
 * could not have been made.
 */
export interface PaletteOperationSpec {
  /** The part after `mcp_<connector_slug>__`. */
  suffix: string;
  /** Audit and operator-facing identity of what is being called. */
  target: string;
  /** One line a person reads next to the approval question, attributed to
   *  the server (`external_tool.server_claim`): its display title, or the
   *  opening of its own description. Never the model-facing `description`,
   *  which carries schemas and gate prose. */
  hint?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  toCall: (args: Record<string, unknown>) =>
    | { ok: true; call: RemoteCall }
    | {
        ok: false;
        error: string;
      };
}

/**
 * The palette entry for one remote tool.
 *
 * The description carries three things the model could not otherwise see:
 * the server's own display title, what the server CLAIMS about the tool's
 * effects, and the shape of the typed reply it promises. The claim is
 * reported as a claim ("the server describes this as read-only"), never as
 * a permission — the sentence after it says the confirmation happens
 * regardless, so a model reading the palette is not told something the
 * gate will contradict.
 */
function toolPaletteSpec(
  connector_slug: string,
  descriptor: RemoteToolDescriptor,
): PaletteOperationSpec {
  const advertised = classifyMcpToolSideEffect(descriptor.annotations);
  const title = descriptor.annotations?.title ?? descriptor.title;
  const parts = [
    descriptor.description,
    title && title !== descriptor.name ? `Titled "${title}".` : "",
    advertised === "read"
      ? "The server describes this tool as read-only."
      : "The server does not describe this tool as read-only.",
    descriptor.outputSchema
      ? `Returns structured output shaped like ${JSON.stringify(descriptor.outputSchema)}.`
      : "",
    `External MCP tool (connector ${connector_slug}). Asks for confirmation before running, whatever the server claims about it.`,
  ].filter((s) => s.length > 0);
  const hint = approvalHint(title && title !== descriptor.name ? title : descriptor.description);
  return {
    suffix: descriptor.name,
    target: descriptor.name,
    ...(hint ? { hint } : {}),
    description: parts.join(" — "),
    inputSchema: descriptor.inputSchema,
    toCall: (args) => ({
      ok: true,
      call: { operation: "call_tool", tool: descriptor.name, arguments: args },
    }),
  };
}

const APPROVAL_HINT_MAX = 160;

/** The first line of server prose, clipped to one readable line. */
function approvalHint(text: string | undefined): string | undefined {
  const line = text?.trim().split(/\r?\n/, 1)[0]?.trim();
  if (!line) return undefined;
  return line.length > APPROVAL_HINT_MAX ? `${line.slice(0, APPROVAL_HINT_MAX - 1)}…` : line;
}

/** Connector id + adapter suffix pairs already logged as shadowed, so a
 *  palette rebuilt every turn logs each collision once per process. */
const loggedShadowedAdapters = new Set<string>();

/**
 * Every palette entry one connected server contributes: its remote tools
 * plus whichever read-only adapters its declared capabilities earn.
 *
 * A remote tool wins its name. When the server ships a tool whose name an
 * adapter would take — a `read_resource` TOOL is the case seen in the
 * field — the adapter is left out. Both would address
 * `mcp_<slug>__read_resource`, and the one written last replaced the
 * other: the server's tool, with its own description of which URIs it
 * reads, vanished behind an adapter that can only reach `resources/read`.
 * The server supplies that path itself, so nothing is lost by the omission.
 */
function paletteSpecsFor(server: TenantMcpToolSet, tenant_id: string): PaletteOperationSpec[] {
  const remote = server.tools.map((d) => toolPaletteSpec(server.slug, d));
  const taken = new Set(remote.map((spec) => spec.suffix));
  const adapters = readOnlyPaletteSpecs(server.slug, server.capabilities).filter((spec) => {
    if (!taken.has(spec.suffix)) return true;
    const key = `${server.connector_id}:${spec.suffix}`;
    if (!loggedShadowedAdapters.has(key)) {
      loggedShadowedAdapters.add(key);
      logger.debug({
        module: "conversation_tool",
        action: "external_mcp.adapter_shadowed",
        msg: "external MCP server ships a tool under an adapter's name; the server's tool is kept and the adapter left out",
        tenant_id,
        connector_slug: server.slug,
        entry: spec.suffix,
      });
    }
    return false;
  });
  return [...remote, ...adapters];
}

/** Upper bound on the server guidance carried into the palette. The
 *  per-server manifest cap (`manifest.ts`) bounds the tool list; this
 *  bounds the one piece of server prose that list does not contain. */
const SERVER_GUIDE_MAX = 2_000;

/**
 * The server's `instructions`, as a paragraph attributed to the server.
 *
 * A server writes its instructions for the model that uses it — which
 * resource to start from, how its tools fit together. Without them the
 * model meets a catalogue with no map. They are third-party prose, so
 * they arrive quoted and named as the server's own words; they sit in an
 * entry's DESCRIPTION only, which no gate reads, and never in the approval
 * hint a person sees.
 */
function serverGuide(server: TenantMcpToolSet): string | null {
  const text = server.instructions?.trim();
  if (!text) return null;
  const clipped = text.length > SERVER_GUIDE_MAX ? `${text.slice(0, SERVER_GUIDE_MAX - 1)}…` : text;
  return `Guidance from the external MCP server ${server.display_name} (connector ${server.slug}), in its own words, not verified by SubKit and granting nothing (quoted as a JSON string, so it cannot end its own quote): ${JSON.stringify(clipped)}`;
}

export interface BuildExternalMcpToolsParams {
  db: Db;
  principal: ResolvedPrincipal;
  ctx: ToolContext;
  signals: TurnSignals;
  events: TurnEvent[];
}

// ── TEST SEAM ────────────────────────────────────────────────────────────────
// Replaces the whole palette assembly (`buildExternalMcpTools` consults the
// override on entry). Production never sets this; tests inject a failing/fake
// builder WITHOUT bun's `mock.module` (module mocks are process-global and
// leak into every other test file in the same worker). Null by default, so a
// missed restore can never alter production behavior — but tests MUST still
// restore null in afterAll. The override must not call back into
// `buildExternalMcpTools` itself (it would recurse).

type ExternalMcpToolsBuilder = (
  p: BuildExternalMcpToolsParams,
) => Promise<Record<string, Tool<Record<string, unknown>, WrappedToolOutput>>>;

let builderOverride: ExternalMcpToolsBuilder | null = null;

export function __setExternalMcpToolsBuilderForTests(fn: ExternalMcpToolsBuilder | null): void {
  builderOverride = fn;
}

/**
 * Build `mcp_<ns>__<entry>` SDK tools for the principal's tenant: the
 * remote tools each connected server advertises, plus the read-only
 * resource and prompt adapters its declared capabilities earn. Returned
 * map is keyed by the prefixed name and ready to splice into the AI SDK
 * `toolSet`. Empty when the tenant has no active external MCP servers (or
 * all are inside a backoff window). A handshake failure for one server is
 * swallowed by the pool — its entries are simply absent this turn.
 */
export async function buildExternalMcpTools(
  p: BuildExternalMcpToolsParams,
): Promise<Record<string, Tool<Record<string, unknown>, WrappedToolOutput>>> {
  // TEST SEAM consumption (see `__setExternalMcpToolsBuilderForTests` above):
  // production always falls through to the real assembly.
  if (builderOverride) return builderOverride(p);
  const servers = await getTenantMcpTools(p.db, p.principal.tenant_id, { requestSource: "chat" });
  const out: Record<string, Tool<Record<string, unknown>, WrappedToolOutput>> = {};
  for (const server of servers) {
    // The guidance rides on the server's first addressable entry — once
    // per server, not once per entry, so it costs its length one time.
    let guide = serverGuide(server);
    for (const spec of paletteSpecsFor(server, p.principal.tenant_id)) {
      // The grammar refuses a pair it cannot address rather than
      // truncating it — a truncated name still routes, to whichever
      // server shares the prefix. Skipping ONE entry is the whole cost;
      // letting the throw escape would abort palette assembly and cost
      // the tenant every external tool it has.
      let name: string;
      try {
        name = buildMcpToolName(server.slug, spec.suffix);
      } catch (err) {
        logger.warn({
          module: "conversation_tool",
          action: "external_mcp.entry_unaddressable",
          msg: "external MCP palette entry has no legal tool name; it is absent from this turn's palette",
          tenant_id: p.principal.tenant_id,
          connector_slug: server.slug,
          entry: spec.suffix,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      out[name] = buildOneExternalMcpTool({
        ...p,
        name,
        connector_slug: server.slug,
        connector_id: server.connector_id,
        connector_name: server.display_name,
        connector_url: server.url,
        spec: guide ? { ...spec, description: `${guide}\n\n${spec.description}` } : spec,
      });
      guide = null;
    }
  }
  return out;
}

interface BuildOneParams extends BuildExternalMcpToolsParams {
  name: string;
  connector_slug: string;
  connector_id: string;
  /** The name a person reads in the approval — never the prefixed tool id. */
  connector_name: string;
  /** The remote endpoint the call's egress record names. */
  connector_url: string;
  spec: PaletteOperationSpec;
}

function buildOneExternalMcpTool(
  p: BuildOneParams,
): Tool<Record<string, unknown>, WrappedToolOutput> {
  const { spec, signals } = p;
  return tool<Record<string, unknown>, WrappedToolOutput, Record<string, unknown>>({
    // AI SDK 7: coerce tool output to JSON-safe for the model (see json-safe-output.ts).
    toModelOutput: jsonSafeModelOutput,
    description: spec.description,
    // The entry's argument schema plus the confirm markers — this tool pauses
    // unless its connector trusts it, so the model needs a declared slot to
    // carry the `confirm_id` back. The markers are stripped again before the args leave the perimeter.
    inputSchema: jsonSchema(
      withConfirmMarkerProperties(spec.inputSchema) as Parameters<typeof jsonSchema>[0],
    ),
    async execute(
      rawArgs: Record<string, unknown>,
      // The SDK hands every `execute` the turn's abort signal here. It was
      // ignored, so stopping a turn left the outbound remote request
      // running to its own timeout while the caller had already walked
      // away. Threaded through to the pool, which cancels THIS request and
      // leaves the tenant's shared session alone.
      opts?: { abortSignal?: AbortSignal | undefined },
    ): Promise<WrappedToolOutput> {
      // Serialise against other tool executions in this turn — identical
      // to the `wf_<slug>` synthetic wrapper and `wrapOne`'s mutex.
      const prevChain = signals.toolChain;
      let release!: () => void;
      signals.toolChain = new Promise<void>((resolve) => {
        release = resolve;
      });
      await prevChain;
      try {
        return await executeExternalMcpTool({
          ...p,
          rawArgs,
          ...(opts?.abortSignal ? { abortSignal: opts.abortSignal } : {}),
        });
      } finally {
        release();
      }
    },
  });
}

async function executeExternalMcpTool(
  p: BuildOneParams & { rawArgs: Record<string, unknown>; abortSignal?: AbortSignal },
): Promise<WrappedToolOutput> {
  const {
    ctx,
    signals,
    events,
    db,
    name,
    connector_slug,
    connector_id,
    connector_name,
    connector_url,
    spec,
    principal,
    rawArgs,
  } = p;
  const startedAt = Date.now();

  // Defence in depth — production callers always source ctx.tenant_id and
  // principal.tenant_id from the same auth resolution. A mismatch means an
  // upstream refactor broke the invariant; fail loud at the dispatch
  // boundary rather than write audit / invoke rows for the wrong tenant.
  if (ctx.tenant_id !== principal.tenant_id) {
    // Land a durable trail under the auth-resolved tenant before failing.
    // Best-effort: a broken invariant must surface as the throw below — the
    // audit write can never mask it.
    try {
      await recordMcpExternalToolPaletteAssemblyFailed({
        tenant_id: principal.tenant_id,
        actor_id: ctx.actor_id,
        reason: "tenant_mismatch",
        request_source: "chat",
        executor: db,
      });
    } catch (auditErr) {
      logger.warn({
        module: "conversation_tool",
        action: "external_mcp.tenant_mismatch_audit_failed",
        msg: "failed to audit external MCP tenant mismatch; the dispatch still fails loud",
        tenant_id: principal.tenant_id,
        error: auditErr instanceof Error ? auditErr.message : String(auditErr),
      });
    }
    throw new Error(
      `external mcp dispatch: ctx.tenant_id (${ctx.tenant_id}) !== principal.tenant_id (${principal.tenant_id})`,
    );
  }

  // Anchor an assistant message so this dispatch shows up in the same
  // persisted trail real tool calls produce.
  const ensureAnchor = async (): Promise<string> => {
    if (signals.assistantMessageId) return signals.assistantMessageId;
    const messageId = await appendMessage(db, ctx.tenant_id, ctx.conversation_id, "assistant", {});
    signals.assistantMessageId = messageId;
    return messageId;
  };
  const assistantMessageId = await ensureAnchor();

  // RBAC gate — members may invoke tools an admin already registered, but
  // a principal lacking `mcp_external_tool:invoke` is refused before any
  // outbound call leaves the tenant perimeter. The check runs BEFORE the
  // tool-call row is inserted so a denied principal's raw arguments
  // (possibly PII bound for a third-party server) are never persisted —
  // the denied row carries `{ denied: true }` as its input instead.
  const decision = await can(db, {
    tenant_id: principal.tenant_id,
    principal,
    permission: "mcp_external_tool:invoke",
  });
  if (!decision.allow) {
    const deniedInput: Record<string, unknown> = { denied: true };
    const toolCallId = await insertToolCall(db, {
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      parent_message_id: assistantMessageId,
      tool: name,
      input: deniedInput,
      approval_required: false,
    });
    events.push({
      type: "tool_call_start",
      call_id: toolCallId,
      tool: name,
      input_partial: deniedInput,
      parent_message_id: assistantMessageId,
    });
    events.push({
      type: "tool_call_end",
      call_id: toolCallId,
      input: deniedInput,
      parent_message_id: assistantMessageId,
    });
    const output: Record<string, unknown> = {
      ok: false,
      denied: true,
      permission: "mcp_external_tool:invoke",
      reason: decision.reason ?? "permission_denied",
      status: "failed",
    };
    await updateToolCallOutput(db, toolCallId, output, "denied");
    events.push({
      type: "tool_result",
      call_id: toolCallId,
      tool: name,
      output,
      parent_message_id: assistantMessageId,
    });
    recordConversationToolCall({
      category: "tenant_write",
      tool: name,
      outcome: "denied",
      duration_ms: Date.now() - startedAt,
    });
    return { ok: false, data: output };
  }

  // Claim the approval on a confirmed re-issue. The args it was granted for
  // are the REPLAY payload — whatever the model re-sent to satisfy the remote
  // tool's schema is discarded, so an approved call cannot be swapped for a
  // different one. Runs before the tool-call row so the persisted input is
  // the input that actually leaves the perimeter. The RBAC gate above already
  // ran; APPROVAL_APPROVED lands just before the outbound call.
  const confirmed = isConfirmedRequest(rawArgs, undefined);
  const claim = confirmed
    ? await consumeApproval({
        db,
        principal,
        approval_id: confirmIdFromArgs(rawArgs),
        tool: name,
        surface: "chat",
        via: "chat",
      })
    : null;
  const effectiveInput = claim?.ok ? claim.args : stripConfirmMarkers(rawArgs);

  // Tool-call row for the allowed dispatch. The full effective input is
  // persisted on purpose — the determinism contract (`buildModelMessages`
  // replay) rehydrates the exact input the remote tool received.
  const toolCallId = await insertToolCall(db, {
    tenant_id: ctx.tenant_id,
    conversation_id: ctx.conversation_id,
    parent_message_id: assistantMessageId,
    tool: name,
    input: effectiveInput,
    approval_required: false,
  });
  events.push({
    type: "tool_call_start",
    call_id: toolCallId,
    tool: name,
    input_partial: effectiveInput,
    parent_message_id: assistantMessageId,
  });
  events.push({
    type: "tool_call_end",
    call_id: toolCallId,
    input: effectiveInput,
    parent_message_id: assistantMessageId,
  });

  // Resolve the arguments into the remote operation BEFORE the confirm
  // gate. A malformed call must never become a question a human is asked
  // to approve: they would be granting a call that cannot be made, and the
  // grant would be spent when the model corrected itself.
  const resolved = spec.toCall(effectiveInput);
  if (!resolved.ok) {
    const output: Record<string, unknown> = {
      ok: false,
      status: "failed",
      error_code: "invalid_arguments",
      error: `${name} was not called: ${resolved.error}`,
      connector_slug,
      remote_tool: spec.target,
    };
    await updateToolCallOutput(db, toolCallId, output, "error");
    events.push({
      type: "tool_result",
      call_id: toolCallId,
      tool: name,
      output,
      parent_message_id: assistantMessageId,
    });
    recordConversationToolCall({
      category: "tenant_write",
      tool: name,
      outcome: "error",
      duration_ms: Date.now() - startedAt,
    });
    return { ok: false, data: output };
  }

  if (claim && !claim.ok) {
    const output: Record<string, unknown> = {
      ok: false,
      status: "failed",
      error_code: claim.code,
      error: claim.message,
      connector_slug,
      remote_tool: spec.target,
    };
    await updateToolCallOutput(db, toolCallId, output, "denied");
    events.push({
      type: "tool_result",
      call_id: toolCallId,
      tool: name,
      output,
      parent_message_id: assistantMessageId,
    });
    recordConversationToolCall({
      category: "tenant_write",
      tool: name,
      outcome: "denied",
      duration_ms: Date.now() - startedAt,
    });
    return { ok: false, data: output };
  }

  // The ONE confirm gate. `tool` stays the prefixed name so the policy
  // resolver's `mcp_` rule fires (forced confirm under auto/ask/plan);
  // `category: tenant_write` means a read never short-circuits it.
  // `not_available_on_surface` is unreachable here — the gate only withholds
  // `draft_write` on MCP.
  //
  // Operator trust: a remote TOOL (never a resource or prompt adapter whose
  // name happens to match) that an operator marked "Ohne Rückfrage" on this
  // connector, read from the connector row at call time — never from the
  // model's arguments or the server's annotations. Only "plan" is threaded
  // from the turn: it holds even a trusted call. A trusted `proceed` is the
  // one proceed accepted below; any other still meets the refusal.
  const trustedByOperator =
    !claim &&
    resolved.call.operation === "call_tool" &&
    (await readMcpToolsWithoutConfirmation(db, ctx.tenant_id, connector_id)).includes(
      resolved.call.tool,
    );
  const gate = claim
    ? null
    : policyDecide({
        tool: name,
        category: "tenant_write",
        surface: "chat",
        args: effectiveInput,
        ...(ctx.permission_mode === "plan" ? { permission_mode: "plan" as const } : {}),
        ...(trustedByOperator ? { connector_trust: true } : {}),
      });
  const gateRule =
    gate?.kind === "proceed" && trustedByOperator ? ("connector_trust" as const) : undefined;
  if (gate && !gateRule) {
    if (gate.kind === "needs_confirm") {
      // Same-turn single-pending-elicitation guard, mirroring the canonical
      // policy gate in `sdk-wrap/invoke.ts`. Parallel tool use is disabled at
      // the provider layer and the `toolChain` mutex serialises this turn, but
      // if a second write ever slipped through it must NOT supersede the first
      // pending approval — `createElicitation` cancels the prior pending row,
      // which would orphan its still-unclaimed approval handle. Refuse before
      // minting a second approval.
      if (signals.pendingElicitation) {
        const dupOutput: Record<string, unknown> = {
          ok: false,
          status: "failed",
          error_code: "duplicate_pending_elicitation_in_turn",
          error: `Another tool call in this turn already staged an ask_user_confirm (${signals.pendingElicitation.tool_name}). Wait for the operator to resolve it, then re-issue ${name}.`,
          connector_slug,
          remote_tool: spec.target,
        };
        await updateToolCallOutput(db, toolCallId, dupOutput, "denied");
        events.push({
          type: "tool_result",
          call_id: toolCallId,
          tool: name,
          output: dupOutput,
          parent_message_id: assistantMessageId,
        });
        recordConversationToolCall({
          category: "tenant_write",
          tool: name,
          outcome: "denied",
          duration_ms: Date.now() - startedAt,
        });
        return { ok: false, data: dupOutput };
      }
      // `confirm_id` IS the approval id: the model re-issues carrying it as the
      // `__policy_confirm_id` trigger, and `executeExternalMcpTool`'s
      // `consumeApproval` above claims exactly this row. Minting the approval
      // UNGRANTED is only half the gate — a remote MCP call cannot be performed
      // from a harness resume, so the model must re-issue it, and
      // `consumeApproval` demands `granted_at`. The MISSING half is the human
      // GRANT, which the ask_user_confirm below raises: when a HUMAN answers it,
      // the harness grants THIS id and stops (`auto-persist.ts` →
      // `grant_relayed_tool_call`); a model re-issue alone reaches an ungranted
      // row and proceeds nowhere.
      const confirm_id = gate.envelope.tool_call_id;
      const requested = await requestApproval({
        db,
        principal,
        approval_id: confirm_id,
        tool: name,
        surface: "chat",
        via: "chat",
        reason: gate.envelope.reason,
        // A remote MCP server has no dev/prod environment of ours to bind.
        execution_mode: null,
        args: effectiveInput,
      });
      // Field NAMES only, mirroring run_workflow's `input_keys`. NEVER the
      // values — external tool args are bound for a third-party server and may
      // carry sensitive data, so neither the elicitation nor the pending
      // envelope may echo them. Sorted so the shape is deterministic.
      const inputKeys = Object.keys(effectiveInput).sort();
      // The ask_user_confirm a HUMAN answers. Its commit_intent is the
      // GRANT-ONLY carrier `grant_relayed_tool_call`: the harness grants the
      // approval on a human answer and never performs the remote call itself.
      // The handle rides on the persisted row the harness reads; every
      // client-facing projection strips it via `withoutApprovalHandle`.
      // The question names what a person recognises — the connector as it was
      // registered and the tool as the server calls it — not the prefixed
      // palette id. `external_tool` carries the same subject as data, so a
      // client renders it in its own language instead of parsing the prose.
      // What the server says about its own tool is its claim, not ours: it
      // rides as `server_claim` for a client to attribute, and never becomes
      // the intent's description — a server may title a destructive tool
      // "Read-only (safe)".
      const elicitationInput: Record<string, unknown> = {
        kind: "external_write",
        question: `Run the tool "${spec.suffix}" on ${connector_name}?`,
        external_tool: {
          connector: connector_name,
          tool: spec.suffix,
          ...(spec.hint ? { server_claim: spec.hint } : {}),
        },
        target: { tool: name, connector_slug, remote_tool: spec.target },
        pending_output: { connector_slug, remote_tool: spec.target, input_keys: inputKeys },
        commit_intent: {
          kind: "grant_relayed_tool_call",
          payload: { tool: name, approval_id: confirm_id },
          description: `Lets the tool "${spec.suffix}" on ${connector_name} run once.`,
        },
        // Persist the human-reachable link, not just mention it to the model.
        // Withholding it here left the operator with no channel at all on a
        // client that cannot render a form, and left the portal's completion
        // bridge unable to recognise the row.
        ...(requested.approval_url ? { approval_url: requested.approval_url } : {}),
      };
      const elicitationSummary = `Run "${spec.suffix}" on ${connector_name}`;
      const elicitation = await createElicitation(
        {
          tenant_id: ctx.tenant_id,
          conversation_id: ctx.conversation_id,
          tool_call_id: toolCallId,
          parent_message_id: assistantMessageId,
          tool_name: "ask_user_confirm",
          summary: elicitationSummary,
          input: elicitationInput,
          actor_id: ctx.actor_id,
        },
        db,
      );
      signals.pendingChildElicitationIds.push(elicitation.id);
      // The approval handle stays on the persisted row; the model and every
      // client see the prompt minus the capability.
      const operatorInput = withoutApprovalHandle(elicitationInput);
      const pendingOutput = { connector_slug, remote_tool: spec.target, input_keys: inputKeys };
      // The model-facing tool result. `confirm_id` is the re-issue TRIGGER, not
      // a gate — the claim still requires the human grant — so it is safe to
      // show; `approval_url` is a human-only link the model cannot click. The
      // `approval_id` handle itself is never shown.
      const output: Record<string, unknown> = {
        pending: true,
        status: "awaiting_confirmation",
        policy_mode: "confirm_before_execution",
        confirm_required: true,
        confirm_id,
        elicitation_id: elicitation.id,
        note: `Nothing ran. The operator must approve ${name} before it runs — they will see a confirmation in chat${
          requested.approval_url ? ` (or open ${requested.approval_url})` : ""
        }. After they approve, re-issue ${name} with __policy_confirmed: true and __policy_confirm_id: "${confirm_id}" to perform it — the engine replays the arguments it already holds. You cannot approve on their behalf.`,
        connector_slug,
        remote_tool: spec.target,
        pending_output: pendingOutput,
      };
      await updateToolCallOutput(db, toolCallId, output, "pending");
      events.push({
        type: "tool_result",
        call_id: toolCallId,
        tool: name,
        output,
        parent_message_id: assistantMessageId,
      });
      events.push({
        type: "elicit_request",
        elicitation_id: elicitation.id,
        tool_call_id: toolCallId,
        tool_name: "ask_user_confirm",
        summary: elicitation.summary,
        input: operatorInput,
        parent_message_id: assistantMessageId,
        pending_output: pendingOutput,
      });
      signals.pendingElicitation = {
        elicitation_id: elicitation.id,
        tool_name: "ask_user_confirm",
        kind: "external_write",
        summary: elicitationSummary,
        input: operatorInput,
      };
      recordConversationToolCall({
        category: "tenant_write",
        tool: name,
        outcome: "pending",
        duration_ms: Date.now() - startedAt,
      });
      // A top-level `pause` key is what `pausedStopCondition` (loop stopWhen)
      // detects to halt the stream — the turn ends in `awaiting_confirmation`
      // instead of the model barrelling ahead into a re-issue nobody granted.
      return {
        ok: false,
        data: output,
        pause: {
          tool_name: "ask_user_confirm",
          kind: "external_write",
          summary: elicitationSummary,
          elicitation_id: elicitation.id,
          input: operatorInput,
        },
      };
    }
    // Enforce the gate locally, do not trust an out-of-module invariant. An
    // unconfirmed external MCP call MUST resolve to `needs_confirm`: the tool
    // is `tenant_write` and this call passes no `permission_mode`, so
    // `decideToolMode` yields `confirm_before_execution` today. If a future
    // change ever downgrades that (a per-tool override, a threaded
    // `permission_mode:"auto"`), the fall-through below would dispatch a remote
    // write with no approval row and no APPROVAL_APPROVED. Refuse instead of
    // trusting the mode two modules away.
    const output: Record<string, unknown> = {
      ok: false,
      status: "failed",
      error_code: "unexpected_gate_decision",
      error: `Policy returned ${gate.kind} for an unconfirmed ${name}; a remote write must pause for human approval. Nothing was invoked.`,
      connector_slug,
      remote_tool: spec.target,
    };
    await updateToolCallOutput(db, toolCallId, output, "error");
    events.push({
      type: "tool_result",
      call_id: toolCallId,
      tool: name,
      output,
      parent_message_id: assistantMessageId,
    });
    recordConversationToolCall({
      category: "tenant_write",
      tool: name,
      outcome: "error",
      duration_ms: Date.now() - startedAt,
    });
    logger.warn({
      module: "conversation_tool",
      action: "external_mcp.unexpected_gate_decision",
      msg: "unconfirmed external MCP tool did not resolve to needs_confirm — refused rather than dispatched unaudited",
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      tool: name,
      gate_kind: gate.kind,
    });
    return { ok: false, data: output };
  }

  // Authorized and confirmed: record the approval before the payload leaves the
  // tenant perimeter. A write we cannot audit is a write we do not perform.
  if (claim?.ok) {
    const recorded = await recordApprovalApproved({
      db,
      principal,
      claim,
      tool: name,
      via: "chat",
    });
    if (!recorded) {
      const output: Record<string, unknown> = {
        ok: false,
        status: "failed",
        error_code: "approval_audit_failed",
        error: `Confirmation ${claim.approval_id} could not be recorded in the audit log; ${name} was not invoked. Re-issue ${name} to obtain a fresh confirmation.`,
        connector_slug,
        remote_tool: spec.target,
      };
      await updateToolCallOutput(db, toolCallId, output, "error");
      events.push({
        type: "tool_result",
        call_id: toolCallId,
        tool: name,
        output,
        parent_message_id: assistantMessageId,
      });
      recordConversationToolCall({
        category: "tenant_write",
        tool: name,
        outcome: "error",
        duration_ms: Date.now() - startedAt,
      });
      return { ok: false, data: output };
    }
  }

  ctx.onLog?.("info", `invoking external MCP tool ${name}`);
  // The call is egress like a workflow step's: the same `withEgressAudit`
  // record, built by the same `mcpEgressInput`, so "what left the tenant"
  // reads alike for both surfaces. Connector stats and the runtime read
  // count the pool's row, never this one, so a call still counts once.
  const invoked = await withEgressAudit(
    mcpEgressInput({
      executor: db,
      tenant_id: ctx.tenant_id,
      actor_id: principal.id,
      actor_type: principal.kind === "system_account" ? "system_account" : "user",
      connector: { id: connector_id, slug: connector_slug, url: connector_url },
      call: resolved.call,
      source: "tool",
    }),
    () =>
      invokeRemoteTool({
        db,
        tenant_id: ctx.tenant_id,
        // Attribute the `mcp_external_tool.invoked` audit row to the chat
        // principal that drove this turn — never a blurred system actor.
        actor_id: principal.id,
        connector_id,
        connector_slug,
        // Which operation this entry issues is the spec's decision, resolved
        // above from the arguments the human approved.
        call: resolved.call,
        requestSource: "chat",
        // Names the rule on the audit row when the call skipped the pause.
        ...(gateRule ? { gate_rule: gateRule } : {}),
        // Stopping the turn stops the outbound request. The pool cancels this
        // ONE request; the tenant's pooled session is not torn down.
        ...(p.abortSignal ? { signal: p.abortSignal } : {}),
        // Remote progress becomes a `tool_log` event, so a long remote call
        // renders as it runs instead of as a silence. It buys the remote no
        // extra time: the bounded timeout is unaffected by progress.
        ...(ctx.onLog
          ? {
              onProgress: (prog: { progress: number; total?: number; message?: string }) => {
                const of = prog.total !== undefined ? `/${prog.total}` : "";
                ctx.onLog?.(
                  "info",
                  `${name}: ${prog.message ?? "progress"} (${prog.progress}${of})`,
                );
              },
            }
          : {}),
        // `recordMcpExternalToolInvoked` is emitted INSIDE `invokeRemoteTool`
        // with outcome / duration_ms / byte_count — the pool owns that audit
        // so the byte count is the raw remote size, not the truncated view.
      }),
  );

  // Persist the FULL remote content verbatim into the tool-call row. The
  // pool injects no wall-clock / random, so a replay rehydrates the exact
  // same payload (the determinism contract `buildModelMessages` relies
  // on). The model is fed only a truncated view below.
  //
  // `structured_content` is persisted ALONGSIDE `content`, not merged into
  // it: it is the half the SDK validated against the tool's own declared
  // output schema, and a reader who cannot tell them apart cannot tell
  // which half carried that guarantee. `get_raw_result` reaches both.
  const fullPayload: Record<string, unknown> = {
    ok: invoked.ok,
    status: invoked.ok ? "succeeded" : "failed",
    connector_slug,
    remote_tool: spec.target,
    content: invoked.content,
    ...(invoked.structured_content !== undefined
      ? { structured_content: invoked.structured_content }
      : {}),
  };
  await updateToolCallOutput(db, toolCallId, fullPayload, invoked.ok ? "ok" : "error");
  await appendMessage(db, ctx.tenant_id, ctx.conversation_id, "tool", {
    tool: name,
    output: fullPayload,
  });

  // Truncated view for the model — reuse the canonical truncator so an
  // oversized remote payload can't blow subsequent context budgets. The
  // full payload stays on the tool-call row, reachable via get_raw_result.
  const truncated = truncateForLlm(fullPayload);
  const modelOutput = truncated.truncated
    ? {
        ...(truncated.data as Record<string, unknown>),
        _truncated: true,
        _raw_ref: truncated.raw_ref,
        _note: truncated.note,
      }
    : fullPayload;
  events.push({
    type: "tool_result",
    call_id: toolCallId,
    tool: name,
    output: modelOutput,
    parent_message_id: assistantMessageId,
  });
  recordConversationToolCall({
    category: "tenant_write",
    tool: name,
    outcome: invoked.ok ? "ok" : "error",
    duration_ms: Date.now() - startedAt,
  });
  return { ok: invoked.ok, data: modelOutput };
}
