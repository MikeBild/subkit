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

export function isPolicyGatePending(call: ToolCallState): boolean {
  const d = unwrapData(call);
  if (!d) return false;
  const pending = d.pending === true;
  const awaiting = d.status === "awaiting_confirmation";
  const policyMode = typeof d.policy_mode === "string" ? d.policy_mode.toLowerCase() : "";
  return (pending || awaiting) && policyMode === "confirm_before_execution";
}

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

export function previewLines(v: unknown, maxLines = 20, maxWidth = 100): string[] {
  if (v === null || v === undefined) return [];
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

const TITLE_KEYS = ["name", "title", "slug", "project_name", "id", "project_id"] as const;

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
  if (d?.classification === "needs_repair") return "warn";
  if (okFlag === false) return "fail";
  const warnings = Array.isArray(d?.warnings) ? (d?.warnings as unknown[]) : null;
  if (warnings && warnings.length > 0) return "warn";
  if (okFlag === true) return "ok";
  return call.status === "done" ? "ok" : "info";
}

export interface CardProps {
  call: ToolCallState;
}
