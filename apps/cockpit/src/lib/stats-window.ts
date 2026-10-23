export const STATS_WINDOWS = ["24h", "thisWeek", "lastWeek", "thisMonth", "lastMonth"] as const;
export type StatsWindow = (typeof STATS_WINDOWS)[number];
export const DEFAULT_STATS_WINDOW: StatsWindow = "thisWeek";

export function isStatsWindow(value: string): value is StatsWindow {
  return (STATS_WINDOWS as readonly string[]).includes(value);
}
