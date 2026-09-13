// Inline `@`-mention picker for the sk composer.
//
// When the user's buffer has an unresolved `@<query>` token (the
// last whitespace-separated word starts with `@`), the picker
// renders a small palette under the composer with up to 8 matches:
//
//   @README.md
//   @src/commands/chat.ts
//   @workflow:invoice-digest
//   @execution:exec-2025-04-18-…
//
// Arrow keys move the selection, Tab / Enter accepts, Esc dismisses.
// Accept replaces the `@<query>` token with the chosen target.
//
// File matching is cwd-scoped and shallow (max depth 3) so the
// picker stays responsive on large repos. Workflow / execution
// suggestions come from the engine asynchronously but render as
// soon as they arrive — the picker never blocks typing.

import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { useTheme } from "@chat-ui/index.ts";
import { Box, Text, useInput } from "ink";
import type React from "react";
import { useEffect, useMemo, useState } from "react";

export interface MentionCandidate {
  /** Text inserted into the buffer when the user accepts, e.g. `README.md` or `workflow:slug`. */
  value: string;
  /** What to render in the picker row. */
  label: string;
  /** Short category label rendered dim on the right. */
  kind: "file" | "workflow" | "execution";
}

export interface MentionPickerProps {
  /** The in-progress `@<query>` token (without the leading `@`). */
  query: string;
  /** Candidates fetched from the engine (workflows, executions) — merged with file matches. */
  engineCandidates?: readonly MentionCandidate[];
  /** Cwd to scan for file matches. */
  cwd: string;
  /** Suppress keystrokes (tests / modal stacking). */
  inputDisabled?: boolean;
  /** Called when the user picks a candidate; host replaces the token. */
  onPick: (candidate: MentionCandidate) => void;
  onDismiss?: () => void;
}

/** Shallow file scan (max 3 dirs deep, max 200 files) filtered by query substring.
 *  Results are sorted lexicographically — readdirSync returns entries in
 *  filesystem hash order (insertion-ish on macOS APFS, ext4 hash on Linux),
 *  which made the order between dev (macOS) and CI (Ubuntu ext4) differ.
 *  Sorting makes the picker stable for users AND makes index-based component
 *  tests like "↓ moves focus to the next candidate" platform-portable. */
export function scanFiles(cwd: string, query: string, limit = 8): MentionCandidate[] {
  const q = query.toLowerCase();
  const results: MentionCandidate[] = [];
  const stack: { path: string; depth: number }[] = [{ path: cwd, depth: 0 }];
  let visited = 0;
  while (stack.length > 0 && results.length < limit && visited < 600) {
    const { path, depth } = stack.pop() as { path: string; depth: number };
    visited++;
    let dirents: string[];
    try {
      dirents = readdirSync(path).sort();
    } catch {
      continue;
    }
    for (const name of dirents) {
      if (name.startsWith(".")) continue;
      if (name === "node_modules" || name === "dist" || name === "build") continue;
      const abs = join(path, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth < 2) stack.push({ path: abs, depth: depth + 1 });
        continue;
      }
      if (!st.isFile()) continue;
      const rel = relative(cwd, abs);
      const hay = rel.toLowerCase();
      if (q.length === 0 ? depth <= 1 : hay.includes(q)) {
        results.push({
          value: rel,
          label: rel,
          kind: "file",
        });
        if (results.length >= limit) break;
      }
    }
  }
  return results;
}

/**
 * Given a raw buffer value, extract the last `@<query>` token and
 * the offset where it starts (so the host can splice in a pick).
 * Returns null when the buffer does not end with an in-progress
 * mention.
 */
export function extractMention(
  value: string,
  cursor: number,
): { query: string; start: number } | null {
  // Walk left from the cursor over non-space chars; must end on `@`.
  let i = cursor;
  while (i > 0 && !/\s/.test(value.charAt(i - 1))) i--;
  if (i >= cursor) return null;
  if (value.charAt(i) !== "@") return null;
  const token = value.slice(i + 1, cursor);
  // Don't show the picker on trivial starts like `@ ` (space right after @)
  // or when the token contains a space (shouldn't happen, but safe).
  if (/\s/.test(token)) return null;
  return { query: token, start: i };
}

/** Splice `candidate` into `value` at `start`, replacing the `@<query>` token. */
export function applyMention(
  value: string,
  cursor: number,
  start: number,
  candidate: MentionCandidate,
): { value: string; cursor: number } {
  const inserted = `@${candidate.value} `;
  const next = value.slice(0, start) + inserted + value.slice(cursor);
  return { value: next, cursor: start + inserted.length };
}

// ---------- Ink component ----------

export const MentionPicker: React.FC<MentionPickerProps> = ({
  query,
  engineCandidates = [],
  cwd,
  inputDisabled,
  onPick,
  onDismiss,
}) => {
  const theme = useTheme();
  const [focused, setFocused] = useState(0);

  const candidates = useMemo((): MentionCandidate[] => {
    const files = scanFiles(cwd, query, 6);
    const q = query.toLowerCase();
    const filteredEngine = engineCandidates.filter((candidate) =>
      q.length === 0
        ? true
        : candidate.label.toLowerCase().includes(q) || candidate.value.toLowerCase().includes(q),
    );
    return [...files, ...filteredEngine].slice(0, 8);
  }, [cwd, query, engineCandidates]);

  // Reset focus when the candidate list shrinks below the current index.
  useEffect(() => {
    if (focused >= candidates.length) setFocused(0);
  }, [candidates.length, focused]);

  useInput(
    (_ch, key) => {
      if (key.upArrow) {
        setFocused(
          (i) => (i - 1 + Math.max(1, candidates.length)) % Math.max(1, candidates.length),
        );
        return;
      }
      if (key.downArrow) {
        setFocused((i) => (i + 1) % Math.max(1, candidates.length));
        return;
      }
      if (key.tab || key.return) {
        // Read the latest focused index via the functional setter so a
        // press("down")→press("enter") sequence fired back-to-back picks
        // the just-moved-to candidate, not the one that was focused at
        // the prior render. Without this, the Enter handler closes over
        // the pre-arrow `focused` value because React has not yet
        // committed the setFocused(arrow) update before the next
        // useInput tick runs. Reproduced on CI as the MentionPicker
        // "↓ moves focus to the next candidate before Enter" flake.
        setFocused((current) => {
          const pick = candidates[current];
          if (pick) onPick(pick);
          return current;
        });
        return;
      }
      if (key.escape) {
        onDismiss?.();
      }
    },
    { isActive: !inputDisabled },
  );

  if (candidates.length === 0) {
    return (
      <Box marginTop={1}>
        <Text color={theme.severity.dim}>@{query} — no matches (Esc to dismiss)</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.severity.dim}>@-mentions (↑/↓ move · Tab/Enter pick · Esc dismiss)</Text>
      {candidates.map((c, i) => {
        const focusedRow = i === focused;
        const marker = focusedRow ? "▶ " : "  ";
        return (
          <Box key={`mp-${i}-${c.value}`}>
            <Text {...(focusedRow ? { color: theme.role.user, bold: true } : {})}>
              {marker}@{c.label}
            </Text>
            <Text color={theme.severity.dim}> · {c.kind}</Text>
          </Box>
        );
      })}
    </Box>
  );
};
