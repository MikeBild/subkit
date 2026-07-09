// Shared `_meta.subkit` hint builder for MCP tool listings.
//
// Clients (and downstream LLMs) read `_meta.subkit.confirm_required`
// before issuing a tenant.* call. When set, they skip any self-authored
// `ask_user_confirm` dance — the MCP policy gate will raise exactly one
// elicitation on the first call. This removes the "two elicitations for
// one delete" path that a self-authored confirm prompt would otherwise hit.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { resolveToolMode } from "../../conversations/tool-policies.ts";
import type { ToolCategory } from "../../conversations/tools/index.ts";

/** MCP-standard tool annotations (spec `Tool.annotations`). */
export type McpToolAnnotations = NonNullable<Tool["annotations"]>;

export interface SubkitToolMeta {
  category: ToolCategory | "workflow_run";
  confirm_required: boolean;
  destructive: boolean;
}

export interface SubkitToolMetaEnvelope {
  subkit: SubkitToolMeta;
  [k: string]: unknown;
}

/**
 * Tools deliberately categorized `tenant_read` for VISIBILITY (so they stay
 * available in read-only MCP mode) but which CAN mutate external or tenant
 * state. Their advertised MCP side-effect must be honest (write) so a trusted
 * client (claude.ai/ChatGPT) files them under its approval-gated group instead
 * of "always allow":
 *   - call_connector — issues GET/SELECT/query (read) OR PATCH/POST/DELETE/
 *     mutation/S3-PUT (write); conservatively advertised as write/destructive.
 *   - authenticate / self_healing_scan — change state (reauth / repair scan).
 *   - probe_connector / probe_connector_draft — a prod probe can POST against
 *     the vendor surface (`tool-policies.ts` escalates prod probes to
 *     `confirm_before_execution`). They are advertised destructive so the
 *     client's native gate secures that call — the server no longer confirms
 *     on MCP (see `policyDecide`'s MCP shortcut in `tools/policy.ts`), so the
 *     annotation IS the gate. This keeps the invariant "every MCP-reachable
 *     `confirm_before_execution` tool advertises `destructiveHint:true`" whole;
 *     `mcp/tests/tools-list.test.ts` pins it.
 * The runtime gate already treats these correctly via `computeDangerFromInput`
 * (tool-policies.ts); this set keeps the STATIC manifest honest in lockstep.
 */
const WRITE_DESPITE_READ_CATEGORY: ReadonlySet<string> = new Set([
  "call_connector",
  "authenticate",
  "self_healing_scan",
  "probe_connector",
  "probe_connector_draft",
]);

/**
 * Writes that only create/append session state — they never destroy,
 * overwrite, delete, send, or spend. They are honest writes
 * (`readOnlyHint:false`) but carry `destructiveHint:false` so a client does not
 * gate the core authoring loop on every turn. Every other write-classified
 * tool is advertised destructive so it lands in the approval-required group.
 */
const ADDITIVE_WRITES: ReadonlySet<string> = new Set([
  "conversation_start",
  "conversation_append",
  "conversation_respond_elicitation",
]);

/**
 * Honest "this tool only reads" signal — the single source the MCP annotations
 * AND the vendor `_meta` derive from. A tool is advertised read-only iff its
 * visibility category is `tenant_read` and it is not a known write-capable
 * tool mislabeled `tenant_read`. Mirrors the runtime side-effect intent so the
 * static manifest and the runtime gate cannot drift.
 */
function advertisedReadOnly(category: ToolCategory | "workflow_run", toolName: string): boolean {
  if (category !== "tenant_read") return false;
  return !WRITE_DESPITE_READ_CATEGORY.has(toolName);
}

/** Honest "this tool may perform a destructive update" signal — true for every
 *  write except the additive session-only writes (and reads). */
function advertisedDestructive(category: ToolCategory | "workflow_run", toolName: string): boolean {
  if (advertisedReadOnly(category, toolName)) return false;
  return !ADDITIVE_WRITES.has(toolName);
}

/** Conservative "could this ever need confirm?" probe. */
function couldRequireConfirmation(category: ToolCategory, toolName: string): boolean {
  // call_connector/authenticate/self_healing_scan are tenant_read for
  // visibility but can write — so they CAN require confirm on the write path.
  if (WRITE_DESPITE_READ_CATEGORY.has(toolName)) return true;
  if (category === "tenant_read") return false;
  // Probe the resolver with an empty input — if the tool demands
  // confirm even without concrete args, flag it. This intentionally
  // errs on the side of warning the client: `run_workflow` with
  // `environment:"prod"` would gate but with `"dev"` would not; we
  // advertise `confirm_required: true` so clients surface a warning
  // and drop back to a plain execute when the env actually lands.
  const mode = resolveToolMode({
    tool: toolName,
    category,
    input: {},
    overrides: {},
  });
  return mode === "confirm_before_execution";
}

/**
 * Tools that reach systems OUTSIDE subkit's own tenant store — connector
 * HTTP calls, probes, OAuth, docs fetch, dry-runs that execute real steps.
 * Drives `openWorldHint`: strict clients want all four hints explicit, and an
 * accurate `openWorldHint:false` on the internal CRUD/read tools lets them be
 * framed as closed-world (no per-call approval), while the external-reaching
 * set is flagged open-world so the client frames it correctly. Everything not
 * listed operates only on subkit-internal state.
 */
const EXTERNAL_REACHING_TOOLS: ReadonlySet<string> = new Set([
  "call_connector",
  "probe_connector",
  "probe_connector_draft",
  "test_connector",
  "fetch_connector_docs",
  "fetch_connector_self_description",
  "discover_connector_endpoints",
  "authenticate_oauth",
  "request_connector_reauth",
  "dry_run_step",
  "dry_run_workflow",
]);

function reachesExternal(toolName: string): boolean {
  return EXTERNAL_REACHING_TOOLS.has(toolName);
}

export function buildConversationToolMeta(
  category: ToolCategory,
  toolName: string,
): SubkitToolMetaEnvelope {
  return {
    subkit: {
      category,
      confirm_required: couldRequireConfirmation(category, toolName),
      destructive: advertisedDestructive(category, toolName),
    },
  };
}

/**
 * MCP-standard `annotations` for a registry/conversation tool.
 *
 * Unlike the vendor `_meta.subkit.*` hints above (read only by surfaces that
 * understand them), these live in the spec-defined `Tool.annotations` field
 * that generic MCP clients read to decide whether a tool may be invoked
 * without an explicit per-call confirmation. With no annotations a strict
 * client must treat every tool as an opaque possibly-mutating action and
 * gates the write-classified authoring tools (e.g. `conversation_start`) on
 * its own surface. Advertising `readOnlyHint` on the read tools and a precise
 * `destructiveHint` on writes gives the client the signal it needs to permit
 * the call.
 */
export function buildToolAnnotations(
  category: ToolCategory | "workflow_run",
  toolName: string,
): McpToolAnnotations {
  const readOnly = advertisedReadOnly(category, toolName);
  // All four spec hints are set EXPLICITLY: a strict client's validator
  // treats an absent hint as unknown and may gate the tool as a write
  // (per-call approval). Explicit values let it apply its native approval
  // UI precisely — reads run without confirm, writes/externals surface it.
  return {
    readOnlyHint: readOnly,
    // The MCP default for a non-read-only tool is `destructiveHint:true`.
    // NEVER assert `false` on a real write — a trusted client (claude.ai)
    // reads that as a benign "always allow" action and skips its approval
    // prompt, letting a model fire connector writes / live workflow runs with
    // no human in the loop. Only the additive session-only writes opt out.
    destructiveHint: advertisedDestructive(category, toolName),
    // A pure read never mutates, so it is trivially idempotent. Writes make
    // no such guarantee.
    idempotentHint: readOnly,
    openWorldHint: reachesExternal(toolName),
  };
}

/**
 * MCP-standard `annotations` for a `wf_<slug>` workflow-run tool. A saved
 * workflow executes its stored steps/connectors — it can send, commit,
 * overwrite, or delete in external systems. So it is advertised as a write
 * AND destructive, so a trusted client gates the run for approval (prod runs
 * also stay confirm-gated by the policy gate); open-world (reaches external
 * systems). Asserting `destructiveHint:false` here would let a model fire a
 * live workflow run with no approval prompt — exactly what we must avoid.
 */
export function buildWorkflowToolAnnotations(): McpToolAnnotations {
  return {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  };
}

export function buildWorkflowToolMeta(): SubkitToolMetaEnvelope {
  // Workflow runs are policy-driven: `run_workflow` is confirm-gated in
  // prod, auto in dev. The MCP dispatch checks `_meta.environment` at
  // call time and the policy gate fires accordingly — we conservatively
  // advertise `confirm_required: true` so a client can warn before a
  // prod run without the LLM having to read tool-policies.ts.
  return {
    subkit: {
      category: "workflow_run",
      confirm_required: true,
      destructive: true,
    },
  };
}
