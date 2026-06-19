// Calendar heatmap of recent workflow-execution activity, sourced from
// the tenant-scoped /v1/stats/executions endpoint at
// `bucket=day`. Rows are weeks, columns are weekdays; intensity is one
// of five glyphs based on count quintile. Toggle the window with `1`
// (Last 7), `2` (Last 30), `3` (All time). Replaces the prior audit-log
// scrape: stats pre-bucket by day server-side, so the heatmap reflects
// actual run volume rather than a capped tail of recent audit rows.

import { Box, Text, useInput } from "ink";
import type React from "react";
import { useEffect, useState } from "react";
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

const GLYPHS = ["·", "░", "▒", "▓", "█"] as const;

// Day buckets keyed YYYY-MM-DD → execution count, from the per-bucket
// series of the (single, ungrouped) executions stats response.
type DayBuckets = Map<string, number>;

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

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

export const ActivityHeatmap: React.FC<Props> = ({ client }) => {
  const [buckets, setBuckets] = useState<DayBuckets>(new Map());
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [windowKey, setWindowKey] = useState<WindowKey>("30");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        // 366 days is the `day`-bucket window cap; request just under it.
        const from = new Date(Date.now() - 365 * 86_400_000).toISOString();
        const res = await client.statsExecutions({ bucket: "day", from });
        if (cancelled) return;
        const m: DayBuckets = new Map();
        for (const g of res.groups) {
          for (const b of g.buckets) {
            const k = dayKey(b.ts);
            m.set(k, (m.get(k) ?? 0) + b.executions);
          }
        }
        setBuckets(m);
        setTotal(res.totals.executions.count);
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

  const days = windowKey === "7" ? 7 : windowKey === "30" ? 30 : 365;
  const today = new Date();
  const dayList: { iso: string; count: number }[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    dayList.push({ iso, count: buckets.get(iso) ?? 0 });
  }
  dayList.reverse();

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

  const weeks: { iso: string; count: number }[][] = [];
  for (let i = 0; i < dayList.length; i += 7) {
    weeks.push(dayList.slice(i, i + 7));
  }

  const totals = total;
  const streak = computeStreak(buckets);

  return (
    <Box flexDirection="column">
      <Text bold>Activity</Text>
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
          totals: {totals} runs · streak: {streak} day(s)
        </Text>
        <Text color="gray">
          legend: {GLYPHS[0]} none · {GLYPHS[1]} low · {GLYPHS[2]} med · {GLYPHS[3]} high ·{" "}
          {GLYPHS[4]} peak
        </Text>
      </Box>
    </Box>
  );
};
