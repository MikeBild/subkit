export type Budgets = ReadonlyMap<string, number>;

export interface BudgetReport {
  unlisted: Array<{ path: string; measure: number }>;
  grown: Array<{ path: string; measure: number; budget: number }>;
  stale: string[];
}

export function parseBudgets(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [path, budget] = line.split(/\s+/);
    if (!path) continue;
    const parsed = Number(budget);
    out.set(path, Number.isFinite(parsed) && parsed > 0 ? parsed : Number.POSITIVE_INFINITY);
  }
  return out;
}

export function renderBudgets(header: readonly string[], offenders: Budgets): string {
  const rows = [...offenders.entries()].sort(([a], [b]) => a.localeCompare(b));
  const width = rows.reduce((max, [path]) => Math.max(max, path.length), 0);
  const body = rows.map(([path, measure]) => `${path.padEnd(width)}  ${measure}`);
  return `${[...header.map((line) => `# ${line}`.trimEnd()), "", ...body].join("\n")}\n`;
}

export function compareBudgets(offenders: Budgets, budgets: Budgets): BudgetReport {
  const unlisted: BudgetReport["unlisted"] = [];
  const grown: BudgetReport["grown"] = [];
  for (const [path, measure] of [...offenders.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const budget = budgets.get(path);
    if (budget === undefined) unlisted.push({ path, measure });
    else if (measure > budget) grown.push({ path, measure, budget });
  }
  const stale = [...budgets.keys()].filter((path) => !offenders.has(path)).sort();
  return { unlisted, grown, stale };
}

export function shrinkBudgets(budgets: Budgets, offenders: Budgets, acceptNew: boolean): Budgets {
  const out = new Map<string, number>();
  for (const [path, measure] of offenders) {
    const budget = budgets.get(path);
    if (budget !== undefined) out.set(path, Math.min(budget, measure));
    else if (acceptNew) out.set(path, measure);
  }
  return out;
}
