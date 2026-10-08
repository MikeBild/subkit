import type {
  LiveAuthoringReport,
  LiveScenarioScore,
  ScenarioTargets,
  TargetVerdict,
} from "./live-report.ts";

export interface LiveBenchmarkThresholds {
  wall_ms_ratio: number;
  tokens_ratio: number;
  tool_calls_delta: number;
  llm_passes_delta: number;
}

export const DEFAULT_LIVE_BENCHMARK_THRESHOLDS: LiveBenchmarkThresholds = {
  wall_ms_ratio: 0.25,
  tokens_ratio: 0.25,
  tool_calls_delta: 2,
  llm_passes_delta: 1,
};

export interface LiveBenchmarkChange {
  scenario: string;
  metric: string;
  baseline: string | number | null;
  current: string | number | null;
  severity: "regression" | "improvement" | "info";
  message: string;
}

export interface LiveBenchmarkComparison {
  common_scenarios: number;
  new_scenarios: string[];
  missing_scenarios: string[];
  changes: LiveBenchmarkChange[];
  regressions: LiveBenchmarkChange[];
  passed: boolean;
}

function byScenario(report: LiveAuthoringReport): Map<string, LiveScenarioScore> {
  return new Map(report.scenarios.map((s) => [s.scenario, s]));
}

function pctChange(current: number, baseline: number): number | null {
  if (baseline === 0) return current === 0 ? 0 : null;
  return (current - baseline) / baseline;
}

function formatPct(change: number | null): string {
  if (change === null) return "n/a";
  const sign = change > 0 ? "+" : "";
  return `${sign}${Math.round(change * 100)}%`;
}

function addNumericRatioChange(args: {
  changes: LiveBenchmarkChange[];
  scenario: string;
  metric: string;
  baseline: number | undefined;
  current: number | undefined;
  ratio: number;
  lowerIsBetter: boolean;
}): void {
  const { baseline, current } = args;
  if (baseline === undefined || current === undefined) return;
  const change = pctChange(current, baseline);
  if (change === null) {
    if (current !== baseline) {
      args.changes.push({
        scenario: args.scenario,
        metric: args.metric,
        baseline,
        current,
        severity: "info",
        message: `${args.metric} changed from zero baseline to ${current}`,
      });
    }
    return;
  }
  const worse = args.lowerIsBetter ? change > args.ratio : change < -args.ratio;
  const better = args.lowerIsBetter ? change < -args.ratio : change > args.ratio;
  if (!worse && !better) return;
  args.changes.push({
    scenario: args.scenario,
    metric: args.metric,
    baseline,
    current,
    severity: worse ? "regression" : "improvement",
    message: `${args.metric} ${formatPct(change)} (${baseline} -> ${current})`,
  });
}

function addNumericDeltaChange(args: {
  changes: LiveBenchmarkChange[];
  scenario: string;
  metric: string;
  baseline: number | null;
  current: number | null;
  delta: number;
  lowerIsBetter: boolean;
}): void {
  const { baseline, current } = args;
  if (baseline === null || current === null) {
    if (baseline !== current) {
      args.changes.push({
        scenario: args.scenario,
        metric: args.metric,
        baseline,
        current,
        severity: current === null ? "regression" : "improvement",
        message: `${args.metric} changed (${baseline ?? "missing"} -> ${current ?? "missing"})`,
      });
    }
    return;
  }
  const diff = current - baseline;
  const worse = args.lowerIsBetter ? diff > args.delta : diff < -args.delta;
  const better = args.lowerIsBetter ? diff < -args.delta : diff > args.delta;
  if (!worse && !better) return;
  args.changes.push({
    scenario: args.scenario,
    metric: args.metric,
    baseline,
    current,
    severity: worse ? "regression" : "improvement",
    message: `${args.metric} changed by ${diff > 0 ? "+" : ""}${diff} (${baseline} -> ${current})`,
  });
}

function targetVerdictAt(targets: ScenarioTargets, key: string): TargetVerdict | null {
  const value = (targets as unknown as Record<string, TargetVerdict | undefined>)[key];
  return value === "PASS" || value === "FAIL" ? value : null;
}

function addTargetChange(args: {
  changes: LiveBenchmarkChange[];
  scenario: string;
  target: string;
  baseline: TargetVerdict | null;
  current: TargetVerdict | null;
}): void {
  if (args.baseline === args.current) return;
  if (args.baseline === null || args.current === null) {
    args.changes.push({
      scenario: args.scenario,
      metric: `target.${args.target}`,
      baseline: args.baseline,
      current: args.current,
      severity: "info",
      message: `${args.target} only ${args.baseline === null ? "in current" : "in baseline"} (${
        args.baseline ?? "absent"
      } -> ${args.current ?? "absent"})`,
    });
    return;
  }
  const regression = args.baseline === "PASS" && args.current === "FAIL";
  args.changes.push({
    scenario: args.scenario,
    metric: `target.${args.target}`,
    baseline: args.baseline,
    current: args.current,
    severity: regression ? "regression" : "improvement",
    message: `${args.target} ${args.baseline} -> ${args.current}`,
  });
}

export function compareTargets(
  scenario: string,
  baseline: ScenarioTargets,
  current: ScenarioTargets,
): LiveBenchmarkChange[] {
  const changes: LiveBenchmarkChange[] = [];
  const keys = [...new Set([...Object.keys(baseline), ...Object.keys(current)])].sort();
  for (const key of keys) {
    addTargetChange({
      changes,
      scenario,
      target: key,
      baseline: targetVerdictAt(baseline, key),
      current: targetVerdictAt(current, key),
    });
  }
  return changes;
}

function addGuardChange(args: {
  changes: LiveBenchmarkChange[];
  scenario: string;
  baseline: boolean | null;
  current: boolean | null;
}): void {
  if (args.baseline === args.current || args.baseline === null || args.current === null) return;
  args.changes.push({
    scenario: args.scenario,
    metric: "guard_fired",
    baseline: String(args.baseline),
    current: String(args.current),
    severity: args.baseline ? "regression" : "improvement",
    message: `guard_fired ${args.baseline} -> ${args.current}`,
  });
}

export function compareLiveAuthoringReports(
  baseline: LiveAuthoringReport,
  current: LiveAuthoringReport,
  thresholds: LiveBenchmarkThresholds = DEFAULT_LIVE_BENCHMARK_THRESHOLDS,
): LiveBenchmarkComparison {
  const baselineMap = byScenario(baseline);
  const currentMap = byScenario(current);
  const changes: LiveBenchmarkChange[] = [];
  const new_scenarios = [...currentMap.keys()].filter((name) => !baselineMap.has(name)).sort();
  const missing_scenarios = [...baselineMap.keys()].filter((name) => !currentMap.has(name)).sort();
  for (const scenario of missing_scenarios) {
    changes.push({
      scenario,
      metric: "scenario",
      baseline: "present",
      current: "missing",
      severity: "regression",
      message: "scenario missing from current benchmark",
    });
  }

  for (const [scenario, currentScore] of currentMap) {
    const baselineScore = baselineMap.get(scenario);
    if (!baselineScore) continue;
    addNumericRatioChange({
      changes,
      scenario,
      metric: "wall_ms",
      baseline: baselineScore.wall_ms,
      current: currentScore.wall_ms,
      ratio: thresholds.wall_ms_ratio,
      lowerIsBetter: true,
    });
    addNumericRatioChange({
      changes,
      scenario,
      metric: "tokens",
      baseline: baselineScore.tokens,
      current: currentScore.tokens,
      ratio: thresholds.tokens_ratio,
      lowerIsBetter: true,
    });
    addNumericDeltaChange({
      changes,
      scenario,
      metric: "tool_calls",
      baseline: baselineScore.tool_calls,
      current: currentScore.tool_calls,
      delta: thresholds.tool_calls_delta,
      lowerIsBetter: true,
    });
    addNumericDeltaChange({
      changes,
      scenario,
      metric: "llm_passes",
      baseline: baselineScore.llm_passes,
      current: currentScore.llm_passes,
      delta: thresholds.llm_passes_delta,
      lowerIsBetter: true,
    });
    addNumericDeltaChange({
      changes,
      scenario,
      metric: "previews",
      baseline: baselineScore.previews,
      current: currentScore.previews,
      delta: 0,
      lowerIsBetter: true,
    });
    if (baselineScore.content_pass !== currentScore.content_pass) {
      changes.push({
        scenario,
        metric: "content_pass",
        baseline: baselineScore.content_pass ? "PASS" : "FAIL",
        current: currentScore.content_pass ? "PASS" : "FAIL",
        severity: baselineScore.content_pass ? "regression" : "improvement",
        message: `content_pass ${baselineScore.content_pass ? "PASS" : "FAIL"} -> ${
          currentScore.content_pass ? "PASS" : "FAIL"
        }`,
      });
    }
    if (baselineScore.kind !== currentScore.kind) {
      changes.push({
        scenario,
        metric: "kind",
        baseline: baselineScore.kind,
        current: currentScore.kind,
        severity: "info",
        message: `scenario kind ${baselineScore.kind} -> ${currentScore.kind}`,
      });
    }
    addGuardChange({
      changes,
      scenario,
      baseline: baselineScore.guard_fired,
      current: currentScore.guard_fired,
    });
    changes.push(...compareTargets(scenario, baselineScore.targets, currentScore.targets));
  }

  const regressions = changes.filter((c) => c.severity === "regression");
  return {
    common_scenarios: [...currentMap.keys()].filter((name) => baselineMap.has(name)).length,
    new_scenarios,
    missing_scenarios,
    changes,
    regressions,
    passed: regressions.length === 0,
  };
}
