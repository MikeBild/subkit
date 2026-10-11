import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type {
  BenchmarkCounts,
  BenchmarkLoad,
  BenchmarkManifest,
  BenchmarkRun,
  Summary,
} from "./model.ts";
import { compareReleaseCapacity, compareThreshold, summarize } from "./stats.ts";

type Group = {
  key: string;
  case: BenchmarkRun["case"];
  concurrency: number;
  load: BenchmarkLoad;
  samples: BenchmarkRun["samples"];
  totals: BenchmarkCounts;
  measurement_ms: number;
  repeats: Map<number, BenchmarkRun["samples"]>;
};

function loadFor(run: BenchmarkRun): BenchmarkLoad {
  return run.load ?? { mode: "closed", max_outstanding: run.concurrency };
}

function profileLoad(manifest: BenchmarkManifest): BenchmarkLoad {
  return manifest.profile.load ?? { mode: "closed", max_outstanding: 1 };
}

function loadKey(load: BenchmarkLoad): string {
  return `${load.mode}:${load.offered_rate_per_second ?? ""}:${load.max_outstanding}`;
}

function groups(manifest: BenchmarkManifest): Map<string, Group> {
  const result = new Map<string, Group>();
  for (const run of manifest.runs) {
    const load = loadFor(run);
    const key = `${run.case.name}|${run.concurrency}|${loadKey(load)}`;
    const existing = result.get(key) ?? {
      key,
      case: run.case,
      concurrency: run.concurrency,
      load,
      samples: [],
      totals: { count: 0, ok_count: 0, error_count: 0, timeout_count: 0, rejected_count: 0 },
      measurement_ms: 0,
      repeats: new Map<number, BenchmarkRun["samples"]>(),
    };
    existing.samples.push(...run.samples);
    const observed = summarize(run.samples, undefined, run.totals);
    existing.totals.count += observed.count;
    existing.totals.ok_count += observed.ok_count;
    existing.totals.error_count += observed.error_count;
    existing.totals.timeout_count += observed.timeout_count;
    existing.totals.rejected_count += observed.rejected_count;
    existing.measurement_ms += run.measurement_elapsed_ms ?? run.measure_ms;
    const repeat = existing.repeats.get(run.repeat) ?? [];
    repeat.push(...run.samples);
    existing.repeats.set(run.repeat, repeat);
    result.set(key, existing);
  }
  return result;
}

export type Comparison = {
  baseline: string;
  candidate: string;
  manifest_paths?: { baseline: string; candidate: string };
  reference_environment: boolean;
  comparable: boolean;
  comparison_refusal?: string;
  evidence_gaps: string[];
  evidence: {
    baseline: Pick<
      BenchmarkManifest,
      "profile" | "host" | "started_at" | "finished_at" | "source_sha256" | "lockfile_sha256"
    >;
    candidate: Pick<
      BenchmarkManifest,
      "profile" | "host" | "started_at" | "finished_at" | "source_sha256" | "lockfile_sha256"
    >;
  };
  acceptance: "pass" | "fail" | "inconclusive";
  historical_parity: "pass" | "fail" | "inconclusive";
  rows: Array<{
    key: string;
    baseline: Summary;
    candidate: Summary;
    threshold: ReturnType<typeof compareThreshold>;
    release_threshold: ReturnType<typeof compareReleaseCapacity>;
    gated: boolean;
    paired_p95_ratio: {
      estimate?: number;
      ci95?: { low: number; high: number };
      repetitions: number;
      label: "sufficient" | "insufficient";
    };
  }>;
};

function quantile(sorted: number[], percentile: number): number | undefined {
  if (sorted.length === 0) return undefined;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentile) - 1)];
}

function pairedP95Ratio(
  baseline: Group | undefined,
  candidate: Group | undefined,
): {
  estimate?: number;
  ci95?: { low: number; high: number };
  repetitions: number;
  label: "sufficient" | "insufficient";
} {
  if (!baseline || !candidate) return { repetitions: 0, label: "insufficient" };
  const ratios = [...baseline.repeats]
    .sort(([left], [right]) => left - right)
    .flatMap(([repeat, samples]) => {
      const candidateSamples = candidate.repeats.get(repeat);
      if (!candidateSamples) return [];
      const baselineP95 = summarize(samples).p95_ms;
      const candidateP95 = summarize(candidateSamples).p95_ms;
      return baselineP95 && candidateP95 ? [candidateP95 / baselineP95] : [];
    });
  if (ratios.length < 2) return { repetitions: ratios.length, label: "insufficient" };
  const estimate = ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length;
  let state = 0x9e3779b9;
  const random = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const bootstraps = Array.from({ length: 10_000 }, () => {
    let total = 0;
    for (let index = 0; index < ratios.length; index += 1) {
      total += ratios[Math.floor(random() * ratios.length)] as number;
    }
    return total / ratios.length;
  }).sort((left, right) => left - right);
  return {
    estimate,
    ci95: {
      low: quantile(bootstraps, 0.025) as number,
      high: quantile(bootstraps, 0.975) as number,
    },
    repetitions: ratios.length,
    label: ratios.length >= 5 ? "sufficient" : "insufficient",
  };
}

export function compareManifests(
  baseline: BenchmarkManifest,
  candidate: BenchmarkManifest,
): Comparison {
  const previous = groups(baseline);
  const current = groups(candidate);
  const rows = [...current.keys()].sort().map((key) => {
    const baselineGroup = previous.get(key);
    const candidateGroup = current.get(key);
    const baselineSummary = summarize(
      baselineGroup?.samples ?? [],
      baselineGroup?.measurement_ms,
      baselineGroup?.totals,
    );
    const candidateSummary = summarize(
      candidateGroup?.samples ?? [],
      candidateGroup?.measurement_ms,
      candidateGroup?.totals,
    );
    const gated =
      Boolean(baselineGroup) &&
      Boolean(candidateGroup) &&
      candidateGroup?.load.mode === "closed" &&
      (candidateGroup?.case.family === "javascript" || candidateGroup?.case.family === "jsonata") &&
      (candidateGroup?.case.size === "small" || candidateGroup?.case.size === "typical") &&
      (candidateGroup?.key.includes("|1|") || candidateGroup?.key.includes("|4|"));
    return {
      key,
      baseline: baselineSummary,
      candidate: candidateSummary,
      threshold: compareThreshold(baselineSummary, candidateSummary),
      release_threshold: compareReleaseCapacity(
        candidateSummary,
        candidateGroup?.concurrency === 4,
      ),
      gated,
      paired_p95_ratio: pairedP95Ratio(baselineGroup, candidateGroup),
    };
  });
  const gatedRows = rows.filter((row) => row.gated);
  const statuses = gatedRows.map((row) => row.release_threshold.status);
  const historicalStatuses = gatedRows.map((row) => row.threshold.status);
  const expectedGates = ["js-small", "js-typical", "jsonata-small", "jsonata-typical"].flatMap(
    (name) => [1, 4].map((concurrency) => `${name}|${concurrency}|closed::${concurrency}`),
  );
  const coverage = expectedGates.every((key) => gatedRows.some((row) => row.key === key));
  const sufficientRepetitions = gatedRows.every((row) => row.paired_p95_ratio.repetitions >= 5);
  const baselineReliable = gatedRows.every(
    (row) =>
      row.baseline.percentile_label === "sufficient" &&
      row.baseline.error_count === 0 &&
      row.baseline.timeout_count === 0 &&
      row.baseline.rejected_count === 0,
  );
  const requiredCorrectness = ["javascript-result", "jsonata-result", "fault-recovery"];
  const requiredHelpers = [
    "helper-money",
    "helper-csv",
    "helper-date",
    "helper-schema",
    "helper-url",
    "helper-xml",
    "helper-template-diff",
  ];
  const correctness = [baseline, candidate].every((manifest) =>
    manifest.correctness.every((check) => check.ok),
  );
  const correctnessCoverage =
    [baseline, candidate].every((manifest) =>
      requiredCorrectness.every((name) =>
        manifest.correctness.some((check) => check.name === name && check.ok),
      ),
    ) &&
    requiredHelpers.every((name) =>
      candidate.correctness.some((check) => check.name === name && check.ok),
    );
  const reference = baseline.host.reference_environment && candidate.host.reference_environment;
  const releaseProfile =
    baseline.profile.name === "release" && candidate.profile.name === "release";
  const comparable =
    JSON.stringify(baseline.profile) === JSON.stringify(candidate.profile) &&
    profileLoad(baseline).mode === profileLoad(candidate).mode &&
    profileLoad(baseline).offered_rate_per_second ===
      profileLoad(candidate).offered_rate_per_second &&
    profileLoad(baseline).max_outstanding === profileLoad(candidate).max_outstanding &&
    baseline.host.platform === candidate.host.platform &&
    baseline.host.arch === candidate.host.arch &&
    baseline.host.cpu_count === candidate.host.cpu_count &&
    baseline.host.bun === candidate.host.bun;
  const acceptance = !correctness
    ? "fail"
    : !comparable ||
        !reference ||
        !releaseProfile ||
        !coverage ||
        !correctnessCoverage ||
        !sufficientRepetitions ||
        !baselineReliable
      ? "inconclusive"
      : statuses.includes("fail")
        ? "fail"
        : statuses.includes("inconclusive")
          ? "inconclusive"
          : "pass";
  const evidence_gaps = [
    ...(!correctness ? ["correctness check failed"] : []),
    ...(!comparable ? ["profiles, load shape, or host shape differ"] : []),
    ...(!reference ? ["reference Linux host is required"] : []),
    ...(!releaseProfile ? ["paired release profile is required"] : []),
    ...(!coverage ? ["one or more required workload rows are missing"] : []),
    ...(!correctnessCoverage ? ["required correctness or helper checks are missing"] : []),
    ...(!sufficientRepetitions ? ["fewer than five paired repetitions"] : []),
    ...(!baselineReliable ? ["baseline has insufficient samples or failures"] : []),
    ...(statuses.includes("inconclusive") ? ["candidate has insufficient capacity evidence"] : []),
  ];
  const historical_parity =
    !comparable || !coverage || !baselineReliable
      ? "inconclusive"
      : historicalStatuses.includes("fail")
        ? "fail"
        : historicalStatuses.includes("inconclusive")
          ? "inconclusive"
          : "pass";
  return {
    baseline: baseline.label,
    candidate: candidate.label,
    reference_environment: reference,
    comparable,
    evidence_gaps,
    evidence: {
      baseline: {
        profile: baseline.profile,
        host: baseline.host,
        started_at: baseline.started_at,
        finished_at: baseline.finished_at,
        source_sha256: baseline.source_sha256,
        lockfile_sha256: baseline.lockfile_sha256,
      },
      candidate: {
        profile: candidate.profile,
        host: candidate.host,
        started_at: candidate.started_at,
        finished_at: candidate.finished_at,
        source_sha256: candidate.source_sha256,
        lockfile_sha256: candidate.lockfile_sha256,
      },
    },
    ...(!comparable ? { comparison_refusal: "profiles, load shape, or host shape differ" } : {}),
    acceptance,
    historical_parity,
    rows,
  };
}

function value(value: number | undefined): string {
  return value === undefined ? "—" : value.toFixed(3);
}

function interval(value: Comparison["rows"][number]["paired_p95_ratio"]): string {
  if (!value.ci95) return "—";
  return `${value.ci95.low.toFixed(3)}–${value.ci95.high.toFixed(3)}`;
}

function svg(rows: Comparison["rows"]): string {
  const width = 900;
  const height = Math.max(140, rows.length * 44 + 64);
  const max = Math.max(
    1,
    ...rows.flatMap((row) => [row.baseline.p95_ms ?? 0, row.candidate.p95_ms ?? 0]),
  );
  const lines = rows
    .map((row, index) => {
      const y = 42 + index * 44;
      const baselineWidth = ((row.baseline.p95_ms ?? 0) / max) * 500;
      const candidateWidth = ((row.candidate.p95_ms ?? 0) / max) * 500;
      return `<text x="8" y="${y}" font-size="12">${escapeXml(row.key)}</text><rect x="310" y="${y - 12}" width="${baselineWidth}" height="10" fill="#526c84"/><rect x="310" y="${y + 2}" width="${candidateWidth}" height="10" fill="#1d8565"/><text x="820" y="${y}" font-size="12">${value(row.candidate.p95_ms)} ms</text>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#ffffff"/><text x="8" y="20" font-size="15" font-weight="bold">p95 latency: baseline (blue), candidate (green)</text>${lines}</svg>`;
}

function escapeXml(value: string): string {
  return value.replace(
    /[<>&"]/g,
    (character) =>
      ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[character] ?? character,
  );
}

function html(comparison: Comparison): string {
  const rows = comparison.rows
    .map(
      (row) =>
        `<tr><td>${escapeXml(row.key)}</td><td>${value(row.baseline.p50_ms)}</td><td>${value(row.baseline.p95_ms)}</td><td>${value(row.baseline.throughput_per_second)}</td><td>${value(row.candidate.p50_ms)}</td><td>${value(row.candidate.p95_ms)}</td><td>${value(row.candidate.throughput_per_second)}</td><td>${row.baseline.sampled_count}/${row.baseline.count}</td><td>${row.candidate.sampled_count}/${row.candidate.count}</td><td>${row.baseline.percentile_label}/${row.candidate.percentile_label}</td><td>${row.baseline.error_count}/${row.baseline.timeout_count}/${row.baseline.rejected_count}</td><td>${row.candidate.error_count}/${row.candidate.timeout_count}/${row.candidate.rejected_count}</td><td>${value(row.paired_p95_ratio.estimate)} ${interval(row.paired_p95_ratio)} (${row.paired_p95_ratio.label})</td><td>${row.gated ? row.release_threshold.status : "observational"}</td><td>${row.gated ? row.threshold.status : "observational"}</td></tr>`,
    )
    .join("");
  const evidence = escapeXml(
    JSON.stringify({ ...comparison.evidence, manifest_paths: comparison.manifest_paths }, null, 2),
  );
  const gaps = comparison.evidence_gaps.map((gap) => `<li>${escapeXml(gap)}</li>`).join("");
  const criteria =
    comparison.evidence.candidate.profile.name === "release"
      ? "Release profile: closed-loop JavaScript and JSONata small/typical workloads at concurrency one and four require p95 at most 100 ms, zero errors, timeouts and rejections, 10,000 successful sampled observations on both sides, and five paired repetitions. Concurrency four additionally requires at least 100 successful operations per second."
      : "This profile does not establish release capacity.";
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Runtime benchmark comparison</title><style>body{font:14px system-ui;margin:32px;color:#14212b}table{border-collapse:collapse;width:100%;margin:24px 0}td,th{border:1px solid #ccd5dd;padding:7px;text-align:left}th{background:#eef3f6}.status{font-weight:700}pre{overflow:auto;background:#eef3f6;padding:12px}</style><h1>Runtime benchmark comparison</h1><p class="status">Capacity acceptance: ${comparison.acceptance}; historical relative comparison (latency and throughput): ${comparison.historical_parity}</p><p>${criteria} Historical relative results are observational for this capacity gate.</p><p>Reference environment: ${comparison.reference_environment ? "yes" : "no"}</p>${gaps ? `<h2>Evidence gaps</h2><ul>${gaps}</ul>` : ""}<h2>Capture provenance</h2><pre>${evidence}</pre><p>Successful latency observations are sampled with a bounded deterministic reservoir; event counts and throughput use all observations. The p95 ratio interval resamples whole paired repetitions, never individual requests.</p><table><thead><tr><th>Workload</th><th>Baseline p50</th><th>Baseline p95</th><th>Baseline ops/s</th><th>Candidate p50</th><th>Candidate p95</th><th>Candidate ops/s</th><th>Baseline sampled/observed</th><th>Candidate sampled/observed</th><th>Percentiles</th><th>Baseline errors/timeouts/rejected</th><th>Candidate errors/timeouts/rejected</th><th>Paired p95 ratio</th><th>Release capacity</th><th>Historical relative</th></tr></thead><tbody>${rows}</tbody></table><img src="runtime-benchmark.svg" alt="p95 latency comparison"></html>`;
}

export async function writeComparison(options: {
  baseline: BenchmarkManifest;
  candidate: BenchmarkManifest;
  output: string;
  baselinePath?: string;
  candidatePath?: string;
}): Promise<Comparison> {
  const comparison: Comparison = {
    ...compareManifests(options.baseline, options.candidate),
    ...(options.baselinePath && options.candidatePath
      ? { manifest_paths: { baseline: options.baselinePath, candidate: options.candidatePath } }
      : {}),
  };
  const output = options.output.endsWith(".json") ? dirname(options.output) : options.output;
  await mkdir(output, { recursive: true });
  const jsonPath = options.output.endsWith(".json")
    ? options.output
    : join(output, "runtime-benchmark-comparison.json");
  await writeFile(jsonPath, `${JSON.stringify(comparison, null, 2)}\n`);
  const chart = svg(comparison.rows);
  await writeFile(join(output, "runtime-benchmark.svg"), chart);
  await writeFile(join(output, "runtime-benchmark.html"), html(comparison));
  return comparison;
}

export function suggestedComparisonName(path: string): string {
  return `${basename(path, ".json")}-comparison`;
}
