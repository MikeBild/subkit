// Honest hold-writes preview envelope for wf_<slug> MCP results.
//
// Every `wf_*` run holds writes. When a write step is held — or a step is
// skipped behind a held write — the run still reports `succeeded` and
// `result.output` carries whatever upstream read/transform last produced.
// Returned bare, that is indistinguishable from a real write: the
// "gemeldet ≠ geschrieben" no-op (a search-over-POST held → the whole write
// chain skipped → the caller saw the converted payload and reported success
// while nothing was written).
//
// The engine signals this with a mandatory `held_preview_no_writes`
// warning. This pure helper lifts that into a first-class `preview`
// envelope + an `_meta.subkit.execution.preview` flag so the model cannot
// mistake a preview for a real write. Step ids + method/url only — the
// (already-redacted) held bodies never ride along.
//
// PROSE CONTRACT: this envelope is read by a model. It states the state and
// names the human affordance — the `approval_url` a PERSON opens to see the
// `would_write` list and approve or decline. It never tells the model to
// approve, because the model cannot: `confirm_tool_call` is a TRIGGER that
// performs writes a human already granted, and it claims nothing until they
// have. Telling the model to "call confirm_tool_call to perform the writes"
// after the link is the truth; telling it to approve them would not be.

import { HELD_PREVIEW_WARNING_CODE, type RunResult } from "../../execution/types.ts";

export interface ResultEnvelope {
  /** True when the run was a held-writes preview (nothing persisted). */
  isHeldPreview: boolean;
  /** The held-preview warning message — for offload summary lines. */
  heldMessage: string | null;
  /** The body to serialize into the MCP text content block. */
  rawBody: unknown;
  /** Spread into the tool result: `{}` or `{ _meta: { subkit: … } }`. */
  previewMeta: Record<string, unknown>;
}

/**
 * What the engine decided about the writes this preview held.
 *
 * `confirm_required` means the approval exists, is UNGRANTED, and is waiting on a
 * person at `approval_url`. Over MCP this is the ONLY outcome a held write can
 * have: approval is portal-only. In-band elicitation is not a grant channel —
 * claude.ai auto-declines the prompt with no human ever seeing it, and
 * production recorded 29/29 elicitation prompts timing out — so the engine never
 * holds an in-band accept or decline. A person opens `approval_url`, reads the
 * `would_write` list, and grants; `confirm_tool_call` then releases the writes.
 * See `mcp/capabilities/tools.ts`.
 */
export type PreviewCommit = {
  readonly kind: "confirm_required";
  /** The `wf_<slug>` tool the approval was opened for. */
  readonly tool: string;
  /** The approval id — `confirm_tool_call`'s `confirm_id`. A TRIGGER handle:
   *  presenting it performs writes a human granted, and approves nothing. */
  readonly confirm_id: string;
  /** Where a person grants the call. `null` when the engine has no configured
   *  `server.public_base_url` and cannot build a link. */
  readonly approval_url: string | null;
  /** WHY the engine has no decision yet — the writes wait on a portal grant. */
  readonly reason: "portal_grant_required";
};

/** The one sentence that names the human affordance. Shared by the inline
 *  envelope and the offloaded summary so a >20 KB result cannot say something
 *  different from a small one. */
export function approvalAffordanceLine(commit: {
  tool: string;
  confirm_id: string;
  approval_url: string | null;
}): string {
  if (!commit.approval_url) {
    // No public origin is configured, so there is no link to hand anyone. Say
    // that, rather than name an affordance that does not exist.
    return ` This engine has no approval portal configured (server.public_base_url is unset), so no approval link exists and these writes cannot be approved. Tell the user to ask an administrator to configure it. Do NOT re-run this tool: approval ${commit.confirm_id} stays ungranted, and confirm_tool_call cannot grant it.`;
  }
  return ` Send this link to the person who must approve: ${commit.approval_url}. After they approve, call confirm_tool_call({ tool: "${commit.tool}", confirm_id: "${commit.confirm_id}" }) to perform the writes. confirm_tool_call performs writes a person already approved — it cannot approve them, and it fails until they do. The engine replays the inputs it already holds; do NOT re-send them, and do NOT re-run this tool.`;
}

/** "1 write step is" / "3 write steps are" — the count the operator approves. */
function heldCountPhrase(count: number): string {
  return count === 1 ? "1 write step is held" : `${count} write steps are held`;
}

/**
 * Shape the MCP result envelope for a completed wf_<slug> run. Honors the
 * pre-existing warnings-wrapping contract (wrap output + warnings when any
 * warning is present; bare output when clean) and adds the held-preview
 * envelope + `_meta` on top when the run held writes.
 *
 * `commit` describes what the engine did about those held writes. It is
 * meaningful only when the run actually held one, so a read-only workflow
 * never advertises a confirmation it has no writes to commit.
 */
export function buildResultEnvelope(
  result: Pick<RunResult, "warnings" | "output" | "execution_id" | "status">,
  commit?: PreviewCommit,
): ResultEnvelope {
  const hasWarnings = (result.warnings?.length ?? 0) > 0;
  const heldPreview = result.warnings?.find((w) => w.code === HELD_PREVIEW_WARNING_CODE);
  if (!heldPreview) {
    return {
      isHeldPreview: false,
      heldMessage: null,
      rawBody: hasWarnings
        ? { output: result.output ?? null, warnings: result.warnings }
        : (result.output ?? null),
      previewMeta: {},
    };
  }
  const details = (heldPreview.details ?? {}) as { held_steps?: unknown; would_write?: unknown };
  const heldSteps = Array.isArray(details.held_steps) ? details.held_steps : [];
  const wouldWrite = Array.isArray(details.would_write) ? details.would_write : [];
  // Name the concrete remedy so the model (and both ChatGPT/claude.ai, which
  // looped here) stops re-running the same held preview: a POST is classified
  // as a write by default, so a render/search step gets held and its
  // dependents are skipped. Re-running the tool only reproduces the preview.
  const misclassifiedRemedy =
    "Held steps are POST/write by default, so each one is held in preview and its " +
    "dependents are skipped. If a held step only READS (e.g. a render or search endpoint), " +
    'set `side_effects: "read"` on that step so it runs in preview and downstream steps are ' +
    "not skipped.";
  // State, then the human affordance. The model is told what to do AFTER a
  // person approves — never to approve, which it cannot.
  const heldCount = wouldWrite.length > 0 ? wouldWrite.length : heldSteps.length;
  const statusLine = ` Nothing was written. ${heldCountPhrase(heldCount)}. A person must approve before they run.`;
  const commitLine = commit?.kind === "confirm_required" ? approvalAffordanceLine(commit) : "";
  return {
    isHeldPreview: true,
    heldMessage: heldPreview.message ?? null,
    rawBody: {
      preview: true,
      writes_held: true,
      message: heldPreview.message,
      remedy: `${misclassifiedRemedy}${statusLine}${commitLine}`,
      ...(commit?.kind === "confirm_required"
        ? {
            awaiting_human_approval: true,
            approval_url: commit.approval_url,
            confirm_id: commit.confirm_id,
            confirm_reason: commit.reason,
          }
        : {}),
      held_steps: heldSteps,
      would_write: wouldWrite,
      output: result.output ?? null,
      warnings: result.warnings,
    },
    previewMeta: {
      _meta: {
        subkit: {
          execution: {
            id: result.execution_id,
            status: result.status,
            preview: true,
            writes_held: true,
            held_steps: heldSteps,
          },
          ...(commit?.kind === "confirm_required"
            ? {
                confirm: {
                  tool: commit.tool,
                  confirm_id: commit.confirm_id,
                  approval_url: commit.approval_url,
                  reason: commit.reason,
                },
              }
            : {}),
        },
      },
    },
  };
}
