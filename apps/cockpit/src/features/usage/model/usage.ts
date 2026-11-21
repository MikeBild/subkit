import { originChart, type UsageOrigin } from "@/features/usage/model/usage-model";

export const DAYS = 30;
export type Area = "workflow" | "chat" | "other";
export const AREAS: readonly Area[] = ["workflow", "chat", "other"];

export const AREA_OF: Record<UsageOrigin, Area> = {
  workflowRuns: "workflow",
  chat: "chat",
  authoring: "other",
  summaries: "other",
  reviews: "other",
  knowledge: "other",
  other: "other",
};

export function lastDays(now: Date, days = DAYS): { from: string; to: string } {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  return { from: from.toISOString(), to: now.toISOString() };
}

export interface UsageDay {
  at: Date;
  cost: number;
  workflow: number;
  chat: number;
  other: number;
}
export interface UsageView {
  measure: "cost" | "tokens";
  days: UsageDay[];
  total: number;
  avg: number;
}

export function usageView(envelope: unknown, span: { from: string; to: string }): UsageView {
  const chart = originChart(envelope, span, "day");
  const days = chart.buckets.map((b) => {
    const d: UsageDay = { at: b.at, cost: b.total, workflow: 0, chat: 0, other: 0 };
    for (const [origin, value] of Object.entries(b.values) as [UsageOrigin, number][])
      d[AREA_OF[origin]] += value;
    return d;
  });
  const total = days.reduce((s, d) => s + d.cost, 0);
  return { measure: chart.measure, days, total, avg: days.length ? total / days.length : 0 };
}

export type UsageTab = "overview" | "breakdown";

const BREAKDOWN_PARAMS = [
  "window",
  "by",
  "origin",
  "workflow",
  "person",
  "model",
  "conversation",
  "failed",
] as const;

export function usageTab(search: string): UsageTab {
  const params = new URLSearchParams(search);
  const tab = params.get("tab");
  if (tab === "breakdown" || params.get("view") === "details") return "breakdown";
  if (tab === "overview") return "overview";
  return BREAKDOWN_PARAMS.some((name) => params.has(name)) ? "breakdown" : "overview";
}

export function usageSearch(search: string, tab: UsageTab): string {
  const params = new URLSearchParams(search);
  params.delete("view");
  if (tab === "breakdown") params.set("tab", "breakdown");
  else {
    params.delete("tab");
    for (const name of BREAKDOWN_PARAMS) params.delete(name);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export const AXIS_WIDTH = 56;

export function axisNumber(tag: string): (value: number) => string {
  const format = new Intl.NumberFormat(tag, { notation: "compact", maximumFractionDigits: 2 });
  return (value) => format.format(value);
}
