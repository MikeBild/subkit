// Tool result truncation for LLM context.
//
// Long tool outputs (e.g. `list_executions` with 50 rows of complex
// payloads, or `inspect_workflow_draft` returning a 1MB nested workflow)
// blow the prompt budget on subsequent turns. We truncate the structured
// output before feeding it back to the model, and stash the raw payload
// under an in-memory ref so a follow-up `get_raw_result` tool call can
// retrieve it on demand.
//
// Two-pass shrink:
//   1. `truncateNode` clips top-level arrays to `MAX_ARRAY_LEN` and
//      nested arrays (depth ≥ 2) to `MAX_NESTED_ARRAY_LEN`.
//   2. If the result is still over `MAX_JSON_CHARS`, the heaviest
//      string/object branches are replaced with
//      `{ __omitted_chars: <n>, __raw_ref: <ref> }` markers in
//      descending-size order until the total fits.
//
// The previous implementation only used pass 1; deeply nested payloads
// (workflow steps carrying snapshots) blew past the cap by 50–100×
// because the per-element budget was unbounded. The bug surfaced as
// "tool output truncated from 1225917 → 482877 chars" — successful
// reduction, still way too large for the prompt budget.

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

const rawStore = new Map<string, unknown>();

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
    if (dropped > 0) mapped.push({ __truncated: `+${dropped} more items` });
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

function shrinkToCap(data: unknown, refId: string, cap: number): unknown {
  let current = approxJsonLength(data);
  if (current <= cap) return data;
  const handles = collectHeaviestBranches(data);
  for (const handle of handles) {
    if (current <= cap) break;
    if (handle.size < 64) continue; // skip tiny branches; not worth it
    handle.replace({ __omitted_chars: handle.size, __raw_ref: refId });
    current = approxJsonLength(data);
  }
  return data;
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
  rawStore.set(refId, output);
  // Evict older entries beyond a soft cap to prevent unbounded growth.
  if (rawStore.size > 256) {
    const firstKey = rawStore.keys().next().value;
    if (firstKey !== undefined) rawStore.delete(firstKey);
  }
  const pass1 = truncateNode(output);
  const shortened = shrinkToCap(pass1, refId, cap);
  const shortenedLen = approxJsonLength(shortened);
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

export function getRawResult(ref: string): unknown | undefined {
  return rawStore.get(ref);
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
  rawStore.set(refId, value);
  if (rawStore.size > 256) {
    const firstKey = rawStore.keys().next().value;
    if (firstKey !== undefined) rawStore.delete(firstKey);
  }
  return refId;
}

export const TRUNCATE_INTERNALS = {
  MAX_JSON_CHARS,
  MAX_ARRAY_LEN,
  MAX_NESTED_ARRAY_LEN,
  MAX_STEP_PREVIEW_CHARS,
};
