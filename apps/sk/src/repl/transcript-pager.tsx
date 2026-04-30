// Full-screen transcript pager (Ctrl+T) — codex `pager_overlay` parity.
//
// Renders every cell with full output / full diff regardless of the
// inline truncation state. Operator scrolls with arrow keys / page
// up/down; Esc or Ctrl+T closes.
//
// Implementation: a fixed-position overlay rendered above the normal
// transcript when active. Uses Ink's Box/Text — no terminal mode
// switch required (the alt-screen toggle is handled separately by
// `alt-screen.tsx` for the inspect mode).

import type { ToolCallState } from "@cli-core/index.ts";
import { Box, Text, useInput } from "ink";
import type React from "react";
import { memo, useState } from "react";
import { DiffCard } from "./diff-cell.tsx";
import { detectPlanSteps, PlanCard } from "./plan-cell.tsx";

export interface PagerEntry {
  id: string;
  kind: "user" | "assistant" | "tool" | "diff";
  /** Raw content for textual cells. */
  text?: string;
  /** Tool call payload — full args + result rendered without truncation. */
  toolCall?: ToolCallState;
  /** Diff payload — rendered fully (no maxLines). */
  diff?: {
    title: string;
    language: "json" | "yaml" | "text";
    hunks: Array<{ kind: "+" | "-" | " "; text: string }>;
  };
}

export interface TranscriptPagerProps {
  open: boolean;
  entries: ReadonlyArray<PagerEntry>;
  onClose: () => void;
  /** Visible window height (rows) — caller passes terminal rows. */
  rows?: number;
}

const TranscriptPagerImpl: React.FC<TranscriptPagerProps> = ({
  open,
  entries,
  onClose,
  rows = 30,
}) => {
  const [scroll, setScroll] = useState(0);

  useInput(
    (input, key) => {
      if (!open) return;
      if (key.escape || (key.ctrl && input === "t")) {
        onClose();
        return;
      }
      if (key.upArrow) setScroll((s) => Math.max(0, s - 1));
      else if (key.downArrow) setScroll((s) => s + 1);
      else if (key.pageUp) setScroll((s) => Math.max(0, s - rows));
      else if (key.pageDown) setScroll((s) => s + rows);
      else if (input === "g") setScroll(0);
      else if (input === "G") setScroll(Number.MAX_SAFE_INTEGER);
    },
    { isActive: open },
  );

  if (!open) return null;
  // Apply scroll offset by slicing entries — coarse but adequate for a
  // pager with ≤200 cells. A full virtual-scroll renderer is overkill.
  const visible = entries.slice(scroll);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text bold color="cyan">
          ─── transcript pager ─────────────────────────────────────────
        </Text>
      </Box>
      <Box>
        <Text color="gray" dimColor>
          {entries.length} entries · ↑↓ scroll · g/G top/bottom · esc / ctrl-t close
        </Text>
      </Box>
      {visible.map((entry) => (
        <PagerEntryRow key={entry.id} entry={entry} />
      ))}
      <Box>
        <Text bold color="cyan">
          ──────────────────────────────────────────────────────────────
        </Text>
      </Box>
    </Box>
  );
};

const PagerEntryRow: React.FC<{ entry: PagerEntry }> = ({ entry }) => {
  if (entry.kind === "user") {
    return (
      <Box marginTop={1}>
        <Text color="green">› you</Text>
        <Text> {entry.text ?? ""}</Text>
      </Box>
    );
  }
  if (entry.kind === "assistant") {
    return (
      <Box marginTop={1} flexDirection="column">
        <Text color="cyan">• sk</Text>
        <Text>{entry.text ?? ""}</Text>
      </Box>
    );
  }
  if (entry.kind === "diff" && entry.diff) {
    return (
      <DiffCard
        title={entry.diff.title}
        language={entry.diff.language}
        hunks={entry.diff.hunks}
        expanded
      />
    );
  }
  if (entry.kind === "tool" && entry.toolCall) {
    const call = entry.toolCall;
    const planSteps = detectPlanSteps(
      call.result && typeof call.result === "object"
        ? ((call.result as { data?: unknown }).data ?? call.result)
        : null,
    );
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="cyan">
          ⏵ {call.name} · {call.status}
        </Text>
        {call.args !== undefined ? (
          <Text color="gray" dimColor>
            args: {safeJson(call.args)}
          </Text>
        ) : null}
        {planSteps ? <PlanCard steps={planSteps} /> : null}
        {call.result !== undefined ? <Text color="gray">{safeJson(call.result)}</Text> : null}
      </Box>
    );
  }
  return null;
};

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export const TranscriptPager = memo(TranscriptPagerImpl);
TranscriptPager.displayName = "TranscriptPager";
