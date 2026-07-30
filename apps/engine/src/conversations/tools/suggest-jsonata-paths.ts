// suggest_jsonata_paths — read-only tool that returns concrete JSONata
// path candidates for a step's recorded output_preview.
//
// Pre-fix the LLM had to guess at `$scope.X.data.Y.Z` paths from the
// connector docs. When the path was wrong the workflow failed
// silently (loop produced 0 rows / transform produced empty array)
// and the LLM cycled through 4–9 path variants. This tool walks the
// most recent dry_run preview for a step and returns ranked path
// candidates so the LLM picks one that actually resolves.
//
// Inputs:
//   - step_id          : the upstream step to read paths from
//   - search_value?    : optional substring; when set, only paths whose
//                        terminal value contains this substring are
//                        returned (case-insensitive). Useful for
//                        "where is the customer email?".
//   - search_key?      : optional regex; when set, only paths whose
//                        last segment matches are returned. Useful for
//                        "where is the .id of each item?".
//
// Returns up to 10 paths in the form `$scope.<step_id>.<path>`,
// already prefixed for direct copy into a transform / loop.

import { z } from "@hono/zod-openapi";
import { and, desc, eq } from "drizzle-orm";
import { executionSteps, executions, workflows, workflowVersions } from "../../db/schema/index.ts";
import {
  buildScopeAtStep,
  enumerateScopePaths,
  summarizeScopeShape,
} from "../../workflows/scope-shape.ts";
import type { WorkflowDraftStepPreview } from "../types.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    step_id: z
      .string()
      .min(1)
      .describe("Upstream step id whose recorded preview should be searched."),
    search_value: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional case-insensitive substring. Only paths whose value contains this substring are returned.",
      ),
    search_key: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional regex applied to each path's last segment. Use to find `.id`, `.email`, `.name` etc.",
      ),
    limit: z.number().int().min(1).max(20).default(10),
  })
  .openapi("SuggestJsonataPathsToolInput");

function readPathValue(root: unknown, path: string): unknown {
  // Walks a `a.b[0].c` path. Returns undefined for any unreadable
  // segment. Wildcards (`[*]`) aren't readable here — they're a
  // documentation artifact for the LLM and never returned as the
  // primary value.
  if (path === "") return root;
  let cur: unknown = root;
  const segments = path.split(/\.|(\[\d+\])/g).filter((s) => s && s.length > 0);
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    const arrayIdx = seg.match(/^\[(\d+)\]$/);
    if (arrayIdx) {
      const idx = Number.parseInt(arrayIdx[1]!, 10);
      if (!Array.isArray(cur)) return undefined;
      cur = cur[idx];
      continue;
    }
    if (typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function lastSegment(path: string): string {
  const m = path.match(/[^.\]]+$/);
  return m ? m[0] : path;
}

export const suggestJsonataPathsTool: ConversationTool = {
  name: "suggest_jsonata_paths",
  description:
    "Return ranked JSONata path candidates for a recorded step preview. Read-only — pulls from `latest_preview.step_traces[step_id].output_preview`. Use when authoring a downstream transform / loop / branch and the upstream shape is unfamiliar.",
  use_case:
    "Before writing a `$scope.<step>.data.…` path in a transform / loop / branch, ask this tool which paths actually exist on the recorded preview. Saves the 4–9× path-guessing spiral observed when the LLM authored against documentation instead of real shape.",
  important_notes: [
    "Requires a recorded preview for `step_id` — call `dry_run_workflow` or `run_workflow` once first.",
    "Paths are returned with the `$scope.<step_id>.` prefix already applied; copy verbatim.",
    "`[*]` paths in the result are a documentation aid — JSONata uses bare path fanout (e.g. `data.items.id` to project `id` over an array).",
  ],
  requires_skill: "workflow-authoring",
  inputSchema,
  category: "tenant_read",
  // Builds a definition rather than using one: withheld from the
  // read-and-execute tier even though it only reads.
  authoring_only: true,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const draft = ctx.getDraft();

    // Resolution order:
    //   1. latest_preview.step_traces — current draft, in-memory
    //   2. workflow_versions.scope_index — most recent committed
    //      version, populated at commit time from step_traces
    //   3. execution_steps.output_preview — most recent successful
    //      execution row (covers re-author of a saved workflow that
    //      was committed before scope_index existed)
    let preview: unknown;
    let trace: WorkflowDraftStepPreview | undefined;
    let source: "latest_preview" | "scope_index" | "execution_steps" | null = null;
    /** True when the live draft has step_traces but none match the
     * requested step_id. Surfaced as `step_not_in_preview` ONLY when
     * none of the fallbacks have any data for this step either —
     * otherwise the fallbacks render the request answerable. */
    let draftHadTracesButNoMatch = false;

    const traces = draft.latest_preview?.step_traces;
    if (Array.isArray(traces) && traces.length > 0) {
      trace = traces.find((t) => t.step_id === args.step_id);
      if (trace?.output_preview !== undefined && trace.output_preview !== null) {
        preview = trace.output_preview;
        source = "latest_preview";
      } else if (!trace) {
        draftHadTracesButNoMatch = true;
      }
    }

    // Resolve the workflow id to consult for the persisted-version
    // fallbacks. During pre-commit authoring `ctx.workflow_id` is
    // null but `draft.summary.active_target.id` carries the target
    // when the conversation has previously bound a persisted
    // workflow. Honour the active_target so the fallback works
    // during repair authoring (most common case for this tool).
    const activeTarget = draft.summary?.active_target;
    const resolvedWorkflowId =
      ctx.workflow_id ??
      (activeTarget?.kind === "workflow" &&
      activeTarget.lifecycle_state === "persisted" &&
      activeTarget.id
        ? activeTarget.id
        : null);

    // Fallback A — committed workflow version's persisted scope_index.
    // This is a step_id → ScopeAtStep map, not a full preview, so we
    // can short-circuit the path enumeration and return its
    // available_paths directly. Only consulted when no live preview
    // exists.
    if (preview === undefined && resolvedWorkflowId) {
      try {
        const rows = await ctx.db
          .select({
            scope_index: workflowVersions.scope_index,
          })
          .from(workflows)
          .innerJoin(workflowVersions, eq(workflowVersions.id, workflows.current_version_id))
          .where(and(eq(workflows.tenant_id, ctx.tenant_id), eq(workflows.id, resolvedWorkflowId)))
          .limit(1);
        const idx = rows[0]?.scope_index as
          | Record<
              string,
              {
                available_paths: string[];
                shape_summary: string;
                primary_data_path: string | null;
              }
            >
          | null
          | undefined;
        const entry = idx?.[args.step_id];
        if (entry) {
          // Synthesise a candidates list straight from the persisted
          // index — we don't have the raw value to readPathValue
          // against, so sample_value is null. The path strings are
          // still copy-paste valid.
          const limited = entry.available_paths.slice(0, args.limit);
          return {
            ok: true,
            data: {
              step_id: args.step_id,
              shape_summary: entry.shape_summary,
              primary_data_path: entry.primary_data_path,
              source: "workflow_versions.scope_index",
              candidates: limited.map((p) => ({
                jsonata: `$scope.${args.step_id}.${p}`,
                placeholder: `\${scope.${args.step_id}.${p}}`,
                relative_path: p,
                sample_value: null,
                reason: "direct" as const,
              })),
              ...(entry.available_paths.length > limited.length ? { truncated: true } : {}),
            },
          };
        }
      } catch {
        // DB blip → fall through to execution_steps fallback.
      }
    }

    // Fallback B — most recent successful execution_steps row for
    // the (workflow_id, step_id) pair.
    if (preview === undefined && resolvedWorkflowId) {
      try {
        const rows = await ctx.db
          .select({
            output_preview: executionSteps.output_preview,
            status: executionSteps.status,
          })
          .from(executionSteps)
          .innerJoin(executions, eq(executions.id, executionSteps.execution_id))
          .where(
            and(
              eq(executionSteps.tenant_id, ctx.tenant_id),
              eq(executions.workflow_id, resolvedWorkflowId),
              eq(executionSteps.step_key, args.step_id),
              eq(executionSteps.status, "succeeded"),
            ),
          )
          .orderBy(desc(executionSteps.finished_at))
          .limit(1);
        const op = rows[0]?.output_preview;
        if (op !== null && op !== undefined) {
          preview = op;
          source = "execution_steps";
        }
      } catch {
        // DB blip — final fallback below.
      }
    }

    if (preview === undefined) {
      if (draftHadTracesButNoMatch && Array.isArray(traces)) {
        const available = traces.map((t) => t.step_id);
        return {
          ok: false,
          error_code: "step_not_in_preview",
          message: `no recorded preview for step \`${args.step_id}\`. Available step ids: ${available.join(", ")}.`,
          details: { available_step_ids: available },
          next_best_actions: ["dry_run_workflow", "inspect_workflow_draft"],
        };
      }
      return {
        ok: false,
        error_code: "no_preview_recorded",
        message:
          "no dry-run / run / persisted scope is available for this step. Call dry_run_workflow once so per-step previews exist, then retry.",
        next_best_actions: ["dry_run_workflow", "inspect_workflow_draft"],
      };
    }
    if (preview === null) {
      return {
        ok: false,
        error_code: "preview_empty",
        message: `step \`${args.step_id}\` ran but produced no output_preview${trace ? ` (status=${trace.status})` : ""}.`,
        details: {
          ...(trace ? { status: trace.status } : {}),
          ...(trace?.error_code ? { error_code: trace.error_code } : {}),
        },
        next_best_actions: ["dry_run_workflow", "inspect_workflow_draft"],
      };
    }

    const paths = enumerateScopePaths(preview, { path_budget: 200 });
    const valueRegex = args.search_value
      ? new RegExp(args.search_value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
      : null;
    const keyRegex = (() => {
      if (!args.search_key) return null;
      try {
        return new RegExp(args.search_key, "i");
      } catch {
        return null;
      }
    })();

    interface Candidate {
      path: string;
      readable_value: unknown;
      reason: "direct" | "value_match" | "key_match";
    }
    const ranked: Candidate[] = [];
    for (const p of paths) {
      const value = readPathValue(preview, p);
      const last = lastSegment(p);
      let reason: Candidate["reason"] | null = null;
      if (keyRegex?.test(last)) reason = "key_match";
      if (
        valueRegex &&
        typeof value !== "object" &&
        value !== null &&
        value !== undefined &&
        valueRegex.test(String(value))
      ) {
        reason = "value_match";
      }
      if (!keyRegex && !valueRegex) reason = "direct";
      if (reason) ranked.push({ path: p, readable_value: value, reason });
    }

    // Stable order: key_match > value_match > direct, then by path
    // length (shorter paths preferred — they're the canonical
    // address).
    const order: Record<Candidate["reason"], number> = {
      key_match: 0,
      value_match: 1,
      direct: 2,
    };
    ranked.sort((a, b) => order[a.reason] - order[b.reason] || a.path.length - b.path.length);
    const limited = ranked.slice(0, args.limit);

    const fallbackScope = !trace ? buildScopeAtStep(preview) : null;
    return {
      ok: true,
      data: {
        step_id: args.step_id,
        source,
        shape_summary: summarizeScopeShape(preview),
        primary_data_path:
          trace?.scope_at_step?.primary_data_path ?? fallbackScope?.primary_data_path ?? null,
        candidates: limited.map((c) => {
          const truncatedValue =
            typeof c.readable_value === "string" && c.readable_value.length > 100
              ? `${c.readable_value.slice(0, 100)}…`
              : c.readable_value;
          return {
            jsonata: `$scope.${args.step_id}.${c.path}`,
            placeholder: `\${scope.${args.step_id}.${c.path}}`,
            relative_path: c.path,
            sample_value: truncatedValue,
            reason: c.reason,
          };
        }),
        ...(ranked.length > limited.length ? { truncated: true } : {}),
      },
    };
  },
};
