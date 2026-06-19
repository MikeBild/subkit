// Filterable run-history table.
//
// Use cases:
//   - "what failed in the last hour"
//   - "show running runs"
//   - "open run X to inspect"
//
// Layout: one row per run, columns: status badge · workflow name · started_at · duration.
// Filter bar at the top lets the operator narrow by status (`f` toggles
// the status quick-filter through ok / running / failed / all).

import { useTheme } from "@chat-ui/index.ts";
import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import type { StepStatus } from "./StepCarousel.tsx";

export interface RunSummary {
  id: string;
  workflow_name: string;
  status: StepStatus;
  started_at: string;
  duration_ms?: number;
}

export interface RunsFilter {
  status?: StepStatus[];
  sinceMs?: number;
}

export interface RunsTableProps {
  runs: RunSummary[];
  filter?: RunsFilter;
  onFilterChange?: (next: RunsFilter) => void;
  onSelect?: (run: RunSummary) => void;
  /** Maximum visible rows. Defaults to 12. */
  maxVisible?: number;
}

const STATUS_CYCLE: Array<StepStatus[] | undefined> = [
  undefined,
  ["running"],
  ["failed"],
  ["succeeded"],
];

export function RunsTable({
  runs,
  filter,
  onFilterChange,
  onSelect,
  maxVisible = 12,
}: RunsTableProps): React.ReactElement {
  const tokens = useTheme();
  const [cursor, setCursor] = useState(0);
  const [internalFilter, setInternalFilter] = useState<RunsFilter>(filter ?? {});
  const effective = filter ?? internalFilter;

  const filtered = useMemo(() => {
    let out = runs;
    if (effective.status && effective.status.length > 0) {
      const set = new Set(effective.status);
      out = out.filter((r) => set.has(r.status));
    }
    if (effective.sinceMs !== undefined) {
      const cutoff = Date.now() - effective.sinceMs;
      out = out.filter((r) => new Date(r.started_at).getTime() >= cutoff);
    }
    return out;
  }, [runs, effective]);

  const visible = filtered.slice(0, maxVisible);
  const safeCursor = Math.min(cursor, Math.max(0, visible.length - 1));

  useInput((input, key) => {
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow) setCursor((c) => Math.min(visible.length - 1, c + 1));
    if (key.return) {
      const r = visible[safeCursor];
      if (r) onSelect?.(r);
    }
    if (input === "f") {
      // Cycle status filter.
      const idx = STATUS_CYCLE.findIndex(
        (s) => JSON.stringify(s) === JSON.stringify(effective.status),
      );
      const next = STATUS_CYCLE[(idx + 1) % STATUS_CYCLE.length];
      const nextFilter: RunsFilter = next === undefined ? {} : { status: next };
      if (onFilterChange) onFilterChange(nextFilter);
      else setInternalFilter(nextFilter);
      setCursor(0);
    }
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Text color={tokens.accent.primary} bold>
          ▸ runs
        </Text>
        <Text color={tokens.severity.dim}>
          {" "}
          · {filtered.length} match · `f` toggles status filter
        </Text>
      </Box>
      <Box>
        <Text color={tokens.severity.dim}>
          filter: {effective.status?.length ? effective.status.map((s) => s).join(",") : "all"}
        </Text>
      </Box>
      {visible.length === 0 ? (
        <Box paddingLeft={2} marginTop={1}>
          <Text color={tokens.severity.dim}>no runs match the current filter</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {visible.map((r, i) => (
            <RunRow key={r.id} run={r} active={i === safeCursor} />
          ))}
          {filtered.length > visible.length ? (
            <Box paddingLeft={2}>
              <Text color={tokens.severity.dim}>
                … {filtered.length - visible.length} more — narrow the filter
              </Text>
            </Box>
          ) : null}
        </Box>
      )}
    </Box>
  );
}

function RunRow({ run, active }: { run: RunSummary; active: boolean }): React.ReactElement {
  const tokens = useTheme();
  const colorByStatus: Record<StepStatus, string> = {
    pending: tokens.severity.dim,
    running: tokens.severity.info,
    succeeded: tokens.badge.ok,
    failed: tokens.badge.fail,
    skipped: tokens.severity.dim,
  };
  const labelByStatus: Record<StepStatus, string> = {
    pending: "pend",
    running: "run ",
    succeeded: "ok  ",
    failed: "fail",
    skipped: "skip",
  };
  const dur =
    run.duration_ms !== undefined
      ? `${Math.round(run.duration_ms / 1000)}s`
      : run.status === "running"
        ? "…"
        : "";
  return (
    <Box flexDirection="row">
      <Text color={active ? tokens.accent.primary : tokens.severity.dim}>{active ? "▶" : " "}</Text>
      <Text> </Text>
      <Text color={colorByStatus[run.status]} bold>
        {labelByStatus[run.status]}
      </Text>
      <Text> </Text>
      <Text color={active ? tokens.accent.primary : tokens.emphasis.normal} bold={active}>
        {run.workflow_name}
      </Text>
      <Text color={tokens.severity.dim}>
        {" "}
        — {new Date(run.started_at).toISOString()} {dur ? `· ${dur}` : ""}
      </Text>
    </Box>
  );
}
