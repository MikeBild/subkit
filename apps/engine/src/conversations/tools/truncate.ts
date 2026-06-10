// Tool result truncation for LLM context.
//
// Long tool outputs (e.g. `list_executions` with 50 rows of complex
// payloads, or `inspect_workflow_draft` returning a 1MB nested workflow)
// blow the prompt budget on subsequent turns. We truncate the structured
// output before feeding it back to the model, and stash the raw payload
// under an in-memory ref so a follow-up `get_raw_result` tool call can
// retrieve it on demand.
//
// Each truncation event emits a structured `truncate.applied` log line
// (level: debug) so operators can see when the budget bites and tune
// MAX_JSON_CHARS / MAX_STEP_PREVIEW_CHARS without instrumenting every
// callsite manually.
//
// Two-pass shrink:
//   1. `truncateNode` clips top-level arrays to `MAX_ARRAY_LEN` and
//      nested arrays (depth ≥ 2) to `MAX_NESTED_ARRAY_LEN`.
//   2. If the result is still over `MAX_JSON_CHARS`, the heaviest
//      string/object branches are replaced with `null` and a
//      sibling-tracked omission count is rolled up into a single
//      top-level `_truncation_note` string — never `__omitted_chars`
//      or `__raw_ref` keys, which previously leaked all the way to the
//      end-user output. The full payload is still recoverable via the
//      `raw_ref` returned alongside the truncated data and the
//      `get_raw_result` tool.
//
// The previous implementation only used pass 1; deeply nested payloads
// (workflow steps carrying snapshots) blew past the cap by 50–100×
// because the per-element budget was unbounded. The bug surfaced as
// "tool output truncated from 1225917 → 482877 chars" — successful
// reduction, still way too large for the prompt budget.

import { logger } from "../../logging/logger.ts";

const MAX_JSON_CHARS = 8000;
const MAX_ARRAY_LEN = 20;
const MAX_NESTED_ARRAY_LEN = 10;
// Per-step cap for `step_trace[i].output_preview` in run_workflow /
// dry_run_workflow envelopes. Sized well below MAX_JSON_CHARS so the
// outer envelope (workflow `output`, `warnings_banner`, every other
// step's preview) still fits comfortably under the LLM cap. Without
// this, a single inline step preview at the 10 KB offload threshold
// (apps/engine/src/execution/offload.ts STEP_RESULT_DB_BYTES) was
// enough to push the envelope over MAX_JSON_CHARS, at which point the
// outer pass would replace the workflow's actual `output` field with
// an `__omitted_chars` / `__raw_ref` marker — exactly the cascade the
// run_workflow that produced "output keys: omitted_chars, raw_ref"
// went through. dry_run_workflow.ts already documents the contract
// ("output_preview is already capped"); this is the missing cap.
const MAX_STEP_PREVIEW_CHARS = 1500;

// Raw-ref retention. Refs are looked up by `get_raw_result` later in the
// same conversation, so eviction must be driven by AGE, not by a small
// FIFO size cap — a busy session could otherwise drop an active ref
// before the model fetched it, surfacing as `raw_ref_not_found`. We keep
// each ref for RAW_REF_TTL_MS and only fall back to insertion-order
// eviction once RAW_REF_MAX_ENTRIES is exceeded as a memory backstop.
const RAW_REF_TTL_MS = 30 * 60_000; // 30 min
// Backstop ceiling for the process-global store. Each entry can be a large
// raw tool payload (>8 KB, sometimes 100s of KB), and this Map is shared
// across every concurrent conversation in the process — so the ceiling is a
// memory bound, not just a cleanliness cap. Kept conservative given the
// engine's prior memory pressure; the per-set expired sweep frees stale
// entries promptly so the resident set tracks "refs from the last TTL".
const RAW_REF_MAX_ENTRIES = 512;

interface RawEntry {
  value: unknown;
  expires_at: number;
}

const rawStore = new Map<string, RawEntry>();

/**
 * Insert a raw payload under `refId`, evicting expired entries first and
 * then trimming by insertion order if still over the backstop ceiling.
 * Shared by `truncateForLlm` and `rememberRaw` so the TTL + backstop
 * policy lives in exactly one place.
 */
function storeRaw(refId: string, value: unknown): void {
  const now = Date.now();
  rawStore.set(refId, { value, expires_at: now + RAW_REF_TTL_MS });
  // Evict by age first.
  for (const [key, entry] of rawStore) {
    if (entry.expires_at < now) rawStore.delete(key);
  }
  // Memory backstop: drop oldest by insertion order until under ceiling.
  while (rawStore.size > RAW_REF_MAX_ENTRIES) {
    const firstKey = rawStore.keys().next().value;
    if (firstKey === undefined) break;
    rawStore.delete(firstKey);
  }
}

export interface TruncatedOutput {
  truncated: boolean;
  data: unknown;
  raw_ref?: string;
  note?: string;
}

function truncateArray(arr: unknown[], cap: number): { arr: unknown[]; dropped: number } {
  if (arr.length <= cap) return { arr, dropped: 0 };
  return { arr: arr.slice(0, cap), dropped: arr.length - cap };
}

function approxJsonLength(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function truncateNode(value: unknown, arrayDepth = 0): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const cap = arrayDepth === 0 ? MAX_ARRAY_LEN : MAX_NESTED_ARRAY_LEN;
    const { arr, dropped } = truncateArray(value, cap);
    const mapped = arr.map((v) => truncateNode(v, arrayDepth + 1));
    // Use a single-leading-underscore key so the renderer's `_`/`__`
    // filter strips it before it reaches the user. Pre-fix this was
    // `__truncated` (double underscore, same prefix as the omitted-
    // chars marker) and surfaced as a literal `__truncated: "+5 more
    // items"` in fallback turns. Single-`_` keeps the marker
    // identifiable for tools that re-walk the structure but ensures it
    // never reaches the end-user view.
    if (dropped > 0) mapped.push({ _truncated: `+${dropped} more items (${value.length} total)` });
    return mapped;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = truncateNode(v, arrayDepth);
  }
  return out;
}

interface BranchHandle {
  size: number;
  replace: (marker: unknown) => void;
}

function collectHeaviestBranches(root: unknown): BranchHandle[] {
  const handles: BranchHandle[] = [];
  function walk(node: unknown): void {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const child = node[i];
        if (child !== null && typeof child === "object") {
          handles.push({
            size: approxJsonLength(child),
            replace: (marker) => {
              node[i] = marker;
            },
          });
          walk(child);
        }
      }
      return;
    }
    const obj = node as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      const child = obj[k];
      if (child !== null && (typeof child === "object" || typeof child === "string")) {
        handles.push({
          size: approxJsonLength(child),
          replace: (marker) => {
            obj[k] = marker;
          },
        });
        if (typeof child === "object") walk(child);
      }
    }
  }
  walk(root);
  // Heaviest first — replacing the biggest branch with a small marker
  // gets us under cap fastest with the least information loss elsewhere.
  handles.sort((a, b) => b.size - a.size);
  return handles;
}

interface ShrinkResult {
  data: unknown;
  branchesOmitted: number;
  charsOmitted: number;
}

function shrinkToCap(data: unknown, cap: number): ShrinkResult {
  let current = approxJsonLength(data);
  if (current <= cap) return { data, branchesOmitted: 0, charsOmitted: 0 };
  const handles = collectHeaviestBranches(data);
  let branchesOmitted = 0;
  let charsOmitted = 0;
  for (const handle of handles) {
    if (current <= cap) break;
    if (handle.size < 64) continue; // skip tiny branches; not worth it
    // Replace the heavy branch with `null` rather than an inline marker
    // object. Pre-fix the marker shape `{__omitted_chars, __raw_ref}`
    // leaked into the LLM context and the fallback renderer alike, so
    // the user saw raw envelope keys in their workflow output (session
    // 0ac7593c). Branch-level provenance is rolled up into a single
    // top-level `_truncation_note` and the full payload remains
    // recoverable via the outer `raw_ref` returned by truncateForLlm.
    handle.replace(null);
    branchesOmitted += 1;
    charsOmitted += handle.size;
    current = approxJsonLength(data);
  }
  return { data, branchesOmitted, charsOmitted };
}

/**
 * Truncate a tool's output to fit LLM context. Stores the full payload
 * under an in-memory ref; callers surface `raw_ref` in the tool result
 * so the model can fetch the untruncated form via `get_raw_result`.
 *
 * `cap` overrides MAX_JSON_CHARS. Used by step-trace assembly to clip
 * each `output_preview` against the smaller MAX_STEP_PREVIEW_CHARS
 * budget before the outer envelope is itself passed through this same
 * function with the default cap.
 */
export function truncateForLlm(output: unknown, cap: number = MAX_JSON_CHARS): TruncatedOutput {
  const originalLen = approxJsonLength(output);
  if (originalLen <= cap) {
    return { truncated: false, data: output };
  }
  const refId = `raw_${crypto.randomUUID().slice(0, 8)}`;
  storeRaw(refId, output);
  const pass1 = truncateNode(output);
  const { data: shortened, branchesOmitted, charsOmitted } = shrinkToCap(pass1, cap);
  const shortenedLen = approxJsonLength(shortened);
  // Roll the per-branch omission accounting into a single top-level
  // `_truncation_note` on the visible payload when the result is an
  // object. The LLM (and the fallback renderer) sees one underscore-
  // prefixed string instead of N inline `{__omitted_chars, __raw_ref}`
  // marker objects. The `_` prefix is filtered by describeToolOutput
  // so it never reaches the end user, and the full payload remains
  // available via `raw_ref`.
  if (
    branchesOmitted > 0 &&
    shortened !== null &&
    typeof shortened === "object" &&
    !Array.isArray(shortened)
  ) {
    (shortened as Record<string, unknown>)._truncation_note =
      `${charsOmitted} chars in ${branchesOmitted} branch(es) omitted; full payload available via get_raw_result(ref="${refId}")`;
  }
  logger.debug({
    module: "conversation_tool",
    action: "truncate.applied",
    msg: "tool output truncated for LLM context",
    cap,
    original_chars: originalLen,
    shortened_chars: shortenedLen,
    branches_omitted: branchesOmitted,
    chars_omitted_in_branches: charsOmitted,
    raw_ref: refId,
  });
  return {
    truncated: true,
    data: shortened,
    raw_ref: refId,
    note: `tool output truncated from ${originalLen} → ${shortenedLen} chars; call get_raw_result(ref="${refId}") for the full payload`,
  };
}

/**
 * Per-step preview cap for `step_trace[i].output_preview`. Wraps
 * `truncateForLlm` with the smaller MAX_STEP_PREVIEW_CHARS budget so
 * a single inline step preview can't dominate the envelope. The full
 * preview remains in the engine's persisted step row and is reachable
 * via `inspect_execution_step` / `diagnose_latest_execution`.
 */
export function truncateStepPreviewForLlm(value: unknown): TruncatedOutput {
  return truncateForLlm(value, MAX_STEP_PREVIEW_CHARS);
}

// Budget for the workflow `output` field inside the run_workflow /
// dry_run_workflow envelope. Sized so a sampled output + step traces +
// lifecycle fields fit comfortably under MAX_JSON_CHARS — pre-fix a large
// output survived intact until the OUTER pass-2 nulled the whole field
// ("status=succeeded · no output" for a 95-row result). Sampling keeps
// REAL rows in front of the model/user with explicit in-band markers.
const MAX_WORKFLOW_OUTPUT_CHARS = 5000;
const SAMPLE_STRING_HEAD_CHARS = 400;

export interface SampledOutput {
  value: unknown;
  sampled: boolean;
  raw_ref?: string;
}

/** Recursively cap arrays/strings for display, marking what was sampled
 *  IN-BAND so the model (and the user reading the summary) knows the
 *  payload is partial — never mistaking the sample for the full result. */
function sampleNode(value: unknown, maxItems: number): unknown {
  if (typeof value === "string") {
    return value.length > SAMPLE_STRING_HEAD_CHARS
      ? `${value.slice(0, SAMPLE_STRING_HEAD_CHARS)}… [${value.length - SAMPLE_STRING_HEAD_CHARS} more chars]`
      : value;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, maxItems).map((v) => sampleNode(v, maxItems));
    if (value.length > maxItems) {
      items.push(`… sampled ${maxItems} of ${value.length} items`);
    }
    return items;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sampleNode(v, maxItems);
    }
    return out;
  }
  return value;
}

/**
 * Shrink a workflow output to a chat-presentable sample. Small outputs
 * pass through untouched. Large ones return REAL leading rows with
 * explicit sampling markers plus a raw_ref to the full payload — the
 * model can answer "show me the top 5" from the sample directly and
 * fetch the rest via get_raw_result only when genuinely needed.
 */
export function sampleWorkflowOutputForLlm(output: unknown): SampledOutput {
  if (output === null || output === undefined) return { value: output, sampled: false };
  let json: string;
  try {
    json = JSON.stringify(output) ?? String(output);
  } catch {
    return { value: output, sampled: false };
  }
  if (json.length <= MAX_WORKFLOW_OUTPUT_CHARS) return { value: output, sampled: false };
  const raw_ref = rememberRaw(output);
  for (const maxItems of [20, 10, 5, 3, 1]) {
    const sampled = sampleNode(output, maxItems);
    try {
      json = JSON.stringify(sampled) ?? "";
    } catch {
      break;
    }
    if (json.length <= MAX_WORKFLOW_OUTPUT_CHARS) {
      logger.debug({
        module: "conversation_tool",
        action: "truncate.output_sampled",
        msg: "workflow output sampled for LLM context",
        original_chars: JSON.stringify(output)?.length ?? 0,
        sampled_chars: json.length,
        max_items: maxItems,
        raw_ref,
      });
      return { value: sampled, sampled: true, raw_ref };
    }
  }
  // Pathological shape (single huge object, no arrays to sample) — fall
  // back to a head excerpt rather than dropping the field entirely.
  return {
    value: `${json.slice(0, 2000)}… [output too large to inline]`,
    sampled: true,
    raw_ref,
  };
}

export function getRawResult(ref: string): unknown | undefined {
  const entry = rawStore.get(ref);
  if (entry === undefined) return undefined;
  if (entry.expires_at < Date.now()) {
    rawStore.delete(ref);
    return undefined;
  }
  return entry.value;
}

export function clearRawStore(): void {
  rawStore.clear();
}

/**
 * Stash an arbitrary value under a fresh ref and return the ref. Used
 * by `persist.buildModelMessages` when eliding old tool outputs that
 * were originally small enough to skip `truncateForLlm` but are now
 * being replaced with a stub on replay.
 */
export function rememberRaw(value: unknown): string {
  const refId = `raw_${crypto.randomUUID().slice(0, 8)}`;
  storeRaw(refId, value);
  return refId;
}

export const TRUNCATE_INTERNALS = {
  MAX_JSON_CHARS,
  MAX_ARRAY_LEN,
  MAX_NESTED_ARRAY_LEN,
  MAX_STEP_PREVIEW_CHARS,
  RAW_REF_TTL_MS,
  RAW_REF_MAX_ENTRIES,
};
