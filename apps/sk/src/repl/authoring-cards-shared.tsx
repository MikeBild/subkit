// Shared chrome and formatting for the authoring milestone cards:
// tone → color/glyph mapping, the tool-result envelope readers
// (asRecord / unwrapData / statusTone / isPolicyGatePending), and the
// output-preview formatters (previewLine / previewLines plus the
// array-of-objects renderer). Extracted from authoring-cards.tsx so
// each card family imports one small surface; authoring-cards.tsx
// re-exports the test-facing pieces.

import type { ToolCallState } from "@cli-core/index.ts";
import { Text } from "ink";
import type React from "react";

export type CardTone = "ok" | "warn" | "fail" | "pending" | "info";

function toneColor(tone: CardTone): string {
  switch (tone) {
    case "ok":
      return "green";
    case "warn":
      return "yellow";
    case "fail":
      return "red";
    case "pending":
      return "yellow";
    default:
      return "cyan";
  }
}

export function badge(tone: CardTone, label: string): React.ReactNode {
  const color = toneColor(tone);
  const glyph =
    tone === "ok"
      ? "✓"
      : tone === "fail"
        ? "×"
        : tone === "pending"
          ? "…"
          : tone === "warn"
            ? "!"
            : "·";
  return (
    <>
      <Text color={color} bold>
        {glyph}
      </Text>
      <Text> </Text>
      <Text bold>{label}</Text>
    </>
  );
}

export function asRecord(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return null;
}

export function unwrapData(call: ToolCallState): Record<string, unknown> | null {
  const r = asRecord(call.result);
  if (!r) return null;
  const inner = asRecord(r.data);
  return inner ?? r;
}

// A tenant-write tool whose policy is `confirm_before_execution`
// returns a sentinel envelope BEFORE the side effect actually runs:
//   { pending: true, status: "awaiting_confirmation",
//     policy_mode: "confirm_before_execution",
//     elicitation_id: "...", note: "policy_confirm_required..." }
// The engine then emits an `elicit_request` event so the operator can
// approve. Rendering this envelope as a green-checked success card
// ("✓ Knowledge source ready") is misleading — nothing has run yet.
// Card dispatchers consult this helper and short-circuit to a
// generic-pending fallback so the operator's mental model matches
// the wire state.
//
// Strict on `policy_mode`: only the literal `"confirm_before_execution"`
// emits this envelope (sdk-wrap/invoke.ts:864 gates on
// `resolvedMode === "confirm_before_execution"`). A previous draft used
// `startsWith("confirm_")` which would silently swallow real success
// cards if a future `confirm_after_execution` flow ever stamped the
// same envelope shape. Case-folded so a future emitter that
// capitalises the mode does not slip past.
// EXPORTED FOR TESTS — keep in sync with the production guard below.
export function isPolicyGatePending(call: ToolCallState): boolean {
  const d = unwrapData(call);
  if (!d) return false;
  const pending = d.pending === true;
  const awaiting = d.status === "awaiting_confirmation";
  const policyMode = typeof d.policy_mode === "string" ? d.policy_mode.toLowerCase() : "";
  return (pending || awaiting) && policyMode === "confirm_before_execution";
}

// Truncate an arbitrary value to a single-line, eye-friendly preview.
// Strings >120 chars are clipped; objects/arrays are JSON-stringified
// and clipped to the same budget. Used by the output-preview blocks so
// every successful run/commit/dry-run renders the actual payload, not
// just a status badge.
export function previewLine(v: unknown, max = 120): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.length > max ? `${v.slice(0, max - 1)}…` : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    const s = JSON.stringify(v);
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  } catch {
    return String(v);
  }
}

// Multi-line output preview: pretty-prints the value to ~20 lines and
// returns each line. Caller renders one <Text> per line under the card.
export function previewLines(v: unknown, maxLines = 20, maxWidth = 100): string[] {
  if (v === null || v === undefined) return [];
  // Array-of-objects: render as a human-readable bulleted list so the
  // operator can read the actual values at a glance instead of having
  // to mentally parse JSON. Pre-fix the run_workflow card showed
  // [{ "project_id": "d6742...", … }] truncated mid-string and the
  // user couldn't see the data — they had to ask the LLM to reformat,
  // which doubled tokens and round-trips. This is chat/MCP-only by
  // construction (the card never renders in HTTP/webhook responses);
  // raw JSON ships unchanged through HTTP.
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object" && v[0] !== null) {
    return renderArrayOfObjects(v as Array<Record<string, unknown>>, maxLines, maxWidth);
  }
  let formatted: string;
  try {
    formatted = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  } catch {
    formatted = String(v);
  }
  const lines = formatted.split("\n");
  const trimmed = lines
    .slice(0, maxLines)
    .map((line) => (line.length > maxWidth ? `${line.slice(0, maxWidth - 1)}…` : line));
  if (lines.length > maxLines) {
    trimmed.push(
      `… +${lines.length - maxLines} more line${lines.length - maxLines === 1 ? "" : "s"}`,
    );
  }
  return trimmed;
}

/**
 * Render an array of objects as a bulleted list:
 *
 *   1. <name-or-id>
 *      • field: value
 *      • nested_array: <count> items
 *
 * Picks a "title" key (name / title / slug / id / ...) heuristically.
 * Nested arrays show their length; nested objects show "<obj>". Long
 * primitive values are truncated to maxWidth. Keeps the operator's
 * mental model aligned with the actual workflow output without
 * forcing the LLM to reformat in prose.
 */
const TITLE_KEYS = ["name", "title", "slug", "project_name", "id", "project_id"] as const;

/**
 * Walk one level into nested objects to find a title-shaped string field.
 * For shape `{ project: { name: "X" }, resources: [...] }` returns
 * `{ key: "project.name", value: "X" }`. Walks one level only — deeper
 * nesting is rare in workflow outputs and would risk picking up unrelated
 * id-like leaves. Falls back to first nested string-valued field on a
 * one-level child if no canonical title key is found.
 */
function findNestedTitle(obj: Record<string, unknown>): { key: string; value: string } | null {
  for (const k of TITLE_KEYS) {
    if (typeof obj[k] === "string") return { key: k, value: obj[k] as string };
  }
  for (const [parentKey, child] of Object.entries(obj)) {
    if (!child || typeof child !== "object" || Array.isArray(child)) continue;
    const childObj = child as Record<string, unknown>;
    for (const k of TITLE_KEYS) {
      if (typeof childObj[k] === "string") {
        return { key: `${parentKey}.${k}`, value: childObj[k] as string };
      }
    }
  }
  // Last-resort: first string field on a nested object whose value
  // isn't itself a path/url/uuid pattern. Keeps the renderer useful
  // even when the upstream API uses non-standard names.
  for (const [parentKey, child] of Object.entries(obj)) {
    if (!child || typeof child !== "object" || Array.isArray(child)) continue;
    const childObj = child as Record<string, unknown>;
    for (const [k, v] of Object.entries(childObj)) {
      if (typeof v === "string" && v.length > 0 && v.length <= 80) {
        return { key: `${parentKey}.${k}`, value: v };
      }
    }
  }
  return null;
}

/**
 * Format a count suffix for arrays / nested arrays of objects so the
 * row reads "Title — N resources" instead of "Title  • resources: <4 items>".
 */
function arrayCountSuffix(obj: Record<string, unknown>): string | null {
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object") {
      return `${v.length} ${k}`;
    }
  }
  return null;
}

function renderArrayOfObjects(
  arr: Array<Record<string, unknown>>,
  maxLines: number,
  maxWidth: number,
): string[] {
  const out: string[] = [];
  const itemBudget = Math.max(2, Math.floor(maxLines / Math.min(arr.length, 10)));
  for (let i = 0; i < arr.length && out.length < maxLines; i++) {
    const obj = arr[i] ?? {};
    const found = findNestedTitle(obj);
    const title = found ? found.value : `item ${i + 1}`;
    const countSuffix = arrayCountSuffix(obj);
    const headline = countSuffix ? `${title} — ${countSuffix}` : title;
    out.push(`${i + 1}. ${headline.slice(0, maxWidth - 4)}`);
    let fieldsRendered = 0;
    const skipKey = found && !found.key.includes(".") ? found.key : null;
    for (const [k, v] of Object.entries(obj)) {
      if (k === skipKey) continue;
      if (fieldsRendered >= itemBudget) break;
      const valueStr = renderValueInline(v, maxWidth - k.length - 8);
      out.push(`   • ${k}: ${valueStr}`);
      fieldsRendered++;
      if (out.length >= maxLines) break;
    }
  }
  if (arr.length * 2 > maxLines) {
    out.push(`… +${arr.length} items total`);
  }
  return out;
}

// Test-only re-export of internal helpers so the array-of-objects
// renderer can be unit-tested without spinning up Ink.
export const __testHooks = { previewLines, renderArrayOfObjects };

function renderValueInline(v: unknown, maxLen: number): string {
  if (v === null || v === undefined) return "—";
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    if (typeof v[0] === "object" && v[0] !== null) return `<${v.length} items>`;
    const joined = v
      .slice(0, 3)
      .map((x) => String(x))
      .join(", ");
    return v.length > 3
      ? `[${joined}, …+${v.length - 3}]`.slice(0, maxLen)
      : `[${joined}]`.slice(0, maxLen);
  }
  if (typeof v === "object") return "<obj>";
  const s = String(v);
  return s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s;
}

export function statusTone(call: ToolCallState): CardTone {
  if (call.status === "failed") return "fail";
  if (call.status === "running" || call.status === "pending") return "pending";
  const d = unwrapData(call);
  const okFlag = d && typeof d.ok === "boolean" ? d.ok : null;
  // A `needs_repair` preview is `ok:false` (the workflow produced broken
  // output — an empty transform, an unresolved ref) but the run itself
  // did not crash. Render it as a warning, not a hard driver failure,
  // so the operator reads "fix this" rather than "the engine died".
  if (d?.classification === "needs_repair") return "warn";
  if (okFlag === false) return "fail";
  // Succeeded run with non-empty `warnings` should look different from
  // a fully clean run — otherwise the operator sees green on a
  // github-private-repos-stats-style `{total_count: 0}` outcome.
  const warnings = Array.isArray(d?.warnings) ? (d?.warnings as unknown[]) : null;
  if (warnings && warnings.length > 0) return "warn";
  if (okFlag === true) return "ok";
  return call.status === "done" ? "ok" : "info";
}

export interface CardProps {
  call: ToolCallState;
}
