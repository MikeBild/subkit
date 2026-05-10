// Stats tab — calendar heatmap of recent activity sourced from the
// audit log. Toggle the window with `1` (Last 7), `2` (Last 30),
// `3` (All time — capped at the engine's audit-log retention).
//
// The heatmap is ASCII-only — no new dependency. Rows are weeks,
// columns are weekdays (Mon–Sun); intensity is rendered as one of
// five glyphs based on count quintile.

import { Box, Text, useInput } from "ink";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import type { EngineClient } from "../../engine-client.ts";

interface Props {
  client: EngineClient;
}

type WindowKey = "7" | "30" | "all";

const WINDOW_LABEL: Record<WindowKey, string> = {
  "7": "Last 7 days",
  "30": "Last 30 days",
  all: "All time",
};

const GLYPHS = [" ", "·", "▒", "▓", "█"] as const;

interface AuditEntry {
  created_at?: unknown;
}

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

function bucketize(items: AuditEntry[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of items) {
    if (typeof e.created_at !== "string") continue;
    const k = dayKey(e.created_at);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

export const StatsTab: React.FC<Props> = ({ client }) => {
  const [items, setItems] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [windowKey, setWindowKey] = useState<WindowKey>("30");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await client.tailAuditLog({ limit: 500 });
        if (cancelled) return;
        setItems(res.items as AuditEntry[]);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  useInput((input) => {
    if (input === "1") setWindowKey("7");
    else if (input === "2") setWindowKey("30");
    else if (input === "3") setWindowKey("all");
  });

  const buckets = useMemo(() => bucketize(items), [items]);
  const days = windowKey === "7" ? 7 : windowKey === "30" ? 30 : Math.max(1, items.length);
  const today = new Date();
  // Build a chronological day list newest → oldest within the window.
  const dayList: { iso: string; count: number }[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    dayList.push({ iso, count: buckets.get(iso) ?? 0 });
  }
  dayList.reverse();

  // Quintile bands: split max-count into 4 thresholds.
  const max = dayList.reduce((m, d) => Math.max(m, d.count), 0);
  const bandFor = (c: number): number => {
    if (max === 0) return 0;
    const ratio = c / max;
    if (ratio === 0) return 0;
    if (ratio <= 0.25) return 1;
    if (ratio <= 0.5) return 2;
    if (ratio <= 0.75) return 3;
    return 4;
  };

  // Group into weeks of 7 cols.
  const weeks: { iso: string; count: number }[][] = [];
  for (let i = 0; i < dayList.length; i += 7) {
    weeks.push(dayList.slice(i, i + 7));
  }

  const totals = items.length;
  const streak = computeStreak(buckets);

  return (
    <Box flexDirection="column">
      <Text bold>Activity heatmap</Text>
      <Box marginTop={1}>
        <Text color="gray">
          1 Last 7 · 2 Last 30 · 3 All time · current: {WINDOW_LABEL[windowKey]}
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {loading ? <Text>loading…</Text> : null}
        {error ? <Text color="red">failed: {error}</Text> : null}
        {!loading && !error
          ? weeks.map((w, i) => (
              <Box key={`week-${i}`}>
                {w.map((d) => (
                  <Text key={d.iso} color={bandFor(d.count) > 0 ? "cyan" : "gray"}>
                    {GLYPHS[bandFor(d.count)]}
                  </Text>
                ))}
              </Box>
            ))
          : null}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color="gray">
          totals: {totals} audit events · streak: {streak} day(s)
        </Text>
        <Text color="gray">
          heatmap glyphs: ░ {GLYPHS[0]} · {GLYPHS[1]} · {GLYPHS[2]} · {GLYPHS[3]} · {GLYPHS[4]}
        </Text>
      </Box>
    </Box>
  );
};

function computeStreak(buckets: Map<string, number>): number {
  let streak = 0;
  const today = new Date();
  for (let i = 0; i < 365; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    if ((buckets.get(iso) ?? 0) > 0) streak++;
    else break;
  }
  return streak;
}
