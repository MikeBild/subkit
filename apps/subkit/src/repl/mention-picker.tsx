import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { useTheme } from "@chat-ui/index.ts";
import { Box, Text, useInput } from "ink";
import type React from "react";
import { useEffect, useMemo, useState } from "react";

export interface MentionCandidate {
  value: string;
  label: string;
  kind: "file" | "workflow" | "execution";
}

export interface MentionPickerProps {
  query: string;
  engineCandidates?: readonly MentionCandidate[];
  cwd: string;
  inputDisabled?: boolean;
  onPick: (candidate: MentionCandidate) => void;
  onDismiss?: () => void;
}

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

export function extractMention(
  value: string,
  cursor: number,
): { query: string; start: number } | null {
  let i = cursor;
  while (i > 0 && !/\s/.test(value.charAt(i - 1))) i--;
  if (i >= cursor) return null;
  if (value.charAt(i) !== "@") return null;
  const token = value.slice(i + 1, cursor);
  if (/\s/.test(token)) return null;
  return { query: token, start: i };
}

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
