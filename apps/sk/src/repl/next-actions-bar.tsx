// Next-actions chip strip — single-line bar rendered under the latest
// assistant reply. Reads `next_best_actions[]` and `suggested_command`
// from the most recent tool result envelope. Single keystroke routes
// to the matching action (R = re-run, D = diagnose, V = view trace,
// / = pre-fill the suggested slash command into the input).
//
// SCAFFOLDING: this component is fully unit-tested but not yet
// imported by `apps/sk/src/ink-app.tsx`. The integration (mounting it
// under the latest assistant message + wiring the single-key handlers
// through ink-app's existing `useInput` discipline) ships in the
// Stage-4 REPL polish PR — see CP2 deviation note in
// `/Users/mikebild/.claude/plans/checkpoints-rustling-lightning.md`.
//
// The bar itself is pure render; keystroke wiring lives in `ink-app.tsx`
// alongside the other `useInput` consumers (the REPL contract is at
// most one active useInput hook at a time, so we never spin up our
// own listener here).

import { useTheme } from "@chat-ui/index.ts";
import { Box, Text } from "ink";
import type React from "react";

export interface NextActionChip {
  /** Single-key shortcut shown in the bar. */
  key: string;
  /** Human label shown after the key. */
  label: string;
}

export interface NextActionsBarProps {
  /**
   * Tool-name → action map driven by the latest tool result's
   * `next_best_actions[]`. The bar maps known actions (re-run,
   * diagnose, view-trace) to single-key shortcuts; unknown entries
   * become tail-of-line chips with no shortcut.
   */
  next_best_actions?: ReadonlyArray<string>;
  /** Slash command the engine suggested (e.g. `/workflows run <slug>`). Pre-filled on `/`. */
  suggested_command?: string | null;
}

const KNOWN_ACTIONS: Record<string, NextActionChip> = {
  run_workflow: { key: "R", label: "re-run" },
  rerun: { key: "R", label: "re-run" },
  diagnose_latest_execution: { key: "D", label: "diagnose" },
  inspect_workflow: { key: "V", label: "view trace" },
  inspect_execution_step: { key: "V", label: "view trace" },
};

/**
 * Build the chip list for an envelope. Order is fixed: re-run, then
 * diagnose, then view trace, then the suggested command. Returns an
 * empty array when nothing matched so the bar can render as null.
 */
export function buildChips(p: NextActionsBarProps): NextActionChip[] {
  const out: NextActionChip[] = [];
  const seen = new Set<string>();
  for (const name of p.next_best_actions ?? []) {
    const chip = KNOWN_ACTIONS[name];
    if (!chip) continue;
    if (seen.has(chip.key)) continue;
    seen.add(chip.key);
    out.push(chip);
  }
  if (p.suggested_command) {
    out.push({ key: "/", label: p.suggested_command });
  }
  return out;
}

export const NextActionsBar: React.FC<NextActionsBarProps> = (props) => {
  const theme = useTheme();
  const chips = buildChips(props);
  if (chips.length === 0) return null;
  return (
    <Box>
      {chips.map((chip, i) => (
        <Box key={`${chip.key}-${i}`}>
          {i > 0 ? <Text color={theme.severity.dim}> · </Text> : null}
          <Text bold color={theme.role.assistant}>
            {chip.key}
          </Text>
          <Text color={theme.severity.dim}> {chip.label}</Text>
        </Box>
      ))}
    </Box>
  );
};
