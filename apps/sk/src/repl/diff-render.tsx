// JsonDiff — recursive structural diff renderer for confirmation
// approvals.
//
// Why a hand-written recursive walk and not the existing
// `StructuredDiff` (line-based LCS)?
//   - StructuredDiff prints raw JSON.stringify lines and runs LCS on
//     them. That's fine for small drafts but loses semantic structure
//     once a payload nests more than two levels — operators stare at
//     bracket arithmetic instead of "field X changed".
//   - The confirmation-diff feature requires per-leaf classification
//     (added / removed / changed / unchanged) so the renderer can
//     color each row independently and the test can assert on the
//     three markers.
//   - Sorted keys keep the output stable across runs (no ordering
//     drift between commits).
//
// Algorithm:
//   diffNodes(before, after, path) walks both shapes in lockstep.
//   For objects we union the key sets (sorted), recurse per key, and
//   indent the children. For arrays we walk index-by-index up to
//   max(len_a, len_b). Leaves (primitives, mismatched kinds) emit a
//   `changed` pair when both sides exist, `added` when before is
//   undefined, `removed` when after is undefined, `unchanged` when
//   the JSON-stringification matches.
//
// `<JsonDiff />` accepts a `maxLines` cap; on overflow it truncates
// and shows a footer the operator can expand by pressing `d`.

import { Box, Text, useInput } from "ink";
import type React from "react";
import { useMemo, useState } from "react";

export type DiffLineKind = "unchanged" | "added" | "removed" | "changed-removed" | "changed-added";

export interface DiffLine {
  kind: DiffLineKind;
  /** 2-space indent count (depth-derived). */
  indent: number;
  /** Rendered text (key + value or just bracket / closer). */
  text: string;
}

export interface JsonDiffProps {
  before: unknown;
  after: unknown;
  /** Max lines before truncation. Default 30 per spec. */
  maxLines?: number;
  /** Disable input listener (used by tests that own focus elsewhere). */
  inputDisabled?: boolean | undefined;
}

/**
 * Public for tests — compute the structured diff lines from a
 * before/after pair without rendering. Used by `diff-render`'s test
 * to assert on the three markers.
 */
export function computeJsonDiffLines(before: unknown, after: unknown): DiffLine[] {
  const out: DiffLine[] = [];
  diffNodes(out, before, after, 0, null);
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function jsonOneLine(v: unknown): string {
  if (v === undefined) return "undefined";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function sameLeaf(a: unknown, b: unknown): boolean {
  return jsonOneLine(a) === jsonOneLine(b);
}

function emit(out: DiffLine[], kind: DiffLineKind, indent: number, text: string): void {
  out.push({ kind, indent, text });
}

/**
 * Render a key+value as a single line. `keyPart` is `"name: "` or empty
 * (for array elements). Primitive values inline; structured values get
 * a placeholder and walk recurses into them.
 */
function leafText(keyPart: string, value: unknown): string {
  return `${keyPart}${jsonOneLine(value)}`;
}

function diffNodes(
  out: DiffLine[],
  before: unknown,
  after: unknown,
  indent: number,
  key: string | number | null,
): void {
  const keyPart = key === null ? "" : typeof key === "number" ? `[${key}]: ` : `${key}: `;

  // Both sides absent → nothing.
  if (before === undefined && after === undefined) return;

  // One side absent.
  if (before === undefined) {
    emitTree(out, after, indent, keyPart, "added");
    return;
  }
  if (after === undefined) {
    emitTree(out, before, indent, keyPart, "removed");
    return;
  }

  // Both objects of the same kind: descend.
  if (isPlainObject(before) && isPlainObject(after)) {
    if (keyPart) emit(out, "unchanged", indent, `${keyPart}{`);
    const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort();
    const childIndent = keyPart ? indent + 1 : indent;
    for (const k of keys) {
      diffNodes(out, before[k], after[k], childIndent, k);
    }
    if (keyPart) emit(out, "unchanged", indent, "}");
    return;
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    if (keyPart) emit(out, "unchanged", indent, `${keyPart}[`);
    const childIndent = keyPart ? indent + 1 : indent;
    const len = Math.max(before.length, after.length);
    for (let i = 0; i < len; i++) {
      const b = i < before.length ? before[i] : undefined;
      const a = i < after.length ? after[i] : undefined;
      diffNodes(out, b, a, childIndent, i);
    }
    if (keyPart) emit(out, "unchanged", indent, "]");
    return;
  }

  // Mixed kinds or primitive vs primitive: emit removed+added (changed)
  // unless they stringify identically.
  if (sameLeaf(before, after)) {
    emit(out, "unchanged", indent, leafText(keyPart, before));
    return;
  }
  // Structural value on either side prints multi-line; collapse to a
  // one-line replacement for the diff readability win.
  emit(out, "changed-removed", indent, leafText(keyPart, before));
  emit(out, "changed-added", indent, leafText(keyPart, after));
}

/**
 * Emit an entire subtree as either `added` or `removed` (used when
 * one side is undefined). Mirrors the structure walk so nested objects
 * still indent correctly.
 */
function emitTree(
  out: DiffLine[],
  value: unknown,
  indent: number,
  keyPart: string,
  kind: "added" | "removed",
): void {
  if (isPlainObject(value)) {
    emit(out, kind, indent, `${keyPart}{`);
    const keys = Object.keys(value).sort();
    for (const k of keys) {
      emitTree(out, value[k], indent + 1, `${k}: `, kind);
    }
    emit(out, kind, indent, "}");
    return;
  }
  if (Array.isArray(value)) {
    emit(out, kind, indent, `${keyPart}[`);
    for (let i = 0; i < value.length; i++) {
      emitTree(out, value[i], indent + 1, `[${i}]: `, kind);
    }
    emit(out, kind, indent, "]");
    return;
  }
  emit(out, kind, indent, leafText(keyPart, value));
}

function colorFor(kind: DiffLineKind): "red" | "green" | undefined {
  if (kind === "added" || kind === "changed-added") return "green";
  if (kind === "removed" || kind === "changed-removed") return "red";
  return undefined;
}

function prefixFor(kind: DiffLineKind): string {
  if (kind === "added" || kind === "changed-added") return "+ ";
  if (kind === "removed" || kind === "changed-removed") return "- ";
  return "  ";
}

/**
 * `<JsonDiff before={...} after={...} maxLines={30} />`
 *
 * Truncates at `maxLines` and shows a footer the operator can expand
 * by pressing `d` (toggles back to truncated on a second press).
 */
export const JsonDiff: React.FC<JsonDiffProps> = ({
  before,
  after,
  maxLines = 30,
  inputDisabled,
}) => {
  const [expanded, setExpanded] = useState(false);
  const lines = useMemo(() => computeJsonDiffLines(before, after), [before, after]);

  useInput(
    (input) => {
      if (input === "d" || input === "D") setExpanded((e) => !e);
    },
    { isActive: !inputDisabled },
  );

  const overflowing = lines.length > maxLines;
  const visible = !overflowing || expanded ? lines : lines.slice(0, maxLines);

  return (
    <Box flexDirection="column">
      {visible.map((line, i) => {
        const color = colorFor(line.kind);
        const prefix = prefixFor(line.kind);
        const pad = "  ".repeat(line.indent);
        const isUnchanged = line.kind === "unchanged";
        if (color) {
          return (
            <Text key={`diff-${i}`} color={color}>
              {prefix}
              {pad}
              {line.text}
            </Text>
          );
        }
        if (isUnchanged) {
          return (
            <Text key={`diff-${i}`} dimColor>
              {prefix}
              {pad}
              {line.text}
            </Text>
          );
        }
        return (
          <Text key={`diff-${i}`}>
            {prefix}
            {pad}
            {line.text}
          </Text>
        );
      })}
      {overflowing && !expanded ? (
        <Text dimColor>... {lines.length - maxLines} more lines (toggle with d) ...</Text>
      ) : null}
      {overflowing && expanded ? <Text dimColor>--- (press d to collapse) ---</Text> : null}
    </Box>
  );
};
