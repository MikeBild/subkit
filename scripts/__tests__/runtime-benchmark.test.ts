import { describe, expect, test } from "bun:test";
import type { BenchmarkManifest } from "../runtime-benchmark/model.ts";
import { compareManifests } from "../runtime-benchmark/report.ts";
import { openLoopSchedule, sampleRecorder } from "../runtime-benchmark/runner.ts";
import { compareReleaseCapacity, summarize } from "../runtime-benchmark/stats.ts";

function manifest(label: string, durations: number[], reference = true): BenchmarkManifest {
  return {
    schema: "subkit-runtime-benchmark",
    label,
    profile: {
      name: "smoke",
      warmup_ms: 0,
      measure_ms: 100,
      repeats: 1,
      concurrency: [1],
      load: { mode: "closed", max_outstanding: 1 },
    },
    started_at: "2000-01-01T00:00:00.000Z",
    finished_at: "2000-01-01T00:00:00.000Z",
    host: {
      platform: "linux",
      arch: "x64",
      bun: "test",
      cpu_count: 4,
      memory_bytes: 8 * 1024 ** 3,
      reference_environment: reference,
    },
    source_root: "/fixture",
    source_sha256: "source",
    lockfile_sha256: "lock",
    runs: [
      {
        case: { name: "js-small", family: "javascript", size: "small" },
        repeat: 1,
        concurrency: 1,
        warmup_ms: 0,
        measure_ms: 0,
        measurement_elapsed_ms: 0,
        load: { mode: "closed", max_outstanding: 1 },
        samples: durations.map((duration_ms) => ({ duration_ms, ok: true })),
        process_memory: { before_rss_bytes: 0, after_rss_bytes: 0, peak_rss_bytes: 0 },
      },
    ],
    correctness: [
      { name: "javascript-result", ok: true },
      { name: "jsonata-result", ok: true },
      { name: "fault-recovery", ok: true },
    ],
  };
}

describe("runtime benchmark statistics", () => {
  test("labels percentile evidence below the required sample count", () => {
    expect(summarize([{ duration_ms: 1, ok: true }]).percentile_label).toBe("insufficient");
  });

  test("separates scheduler rejections and timeouts from execution errors", () => {
    const summary = summarize([
      { duration_ms: 1, ok: true, outcome: "ok" },
      { duration_ms: 2, ok: false, outcome: "rejected" },
      { duration_ms: 3, ok: false, outcome: "timeout" },
      { duration_ms: 4, ok: false, outcome: "error" },
    ]);
    expect(summary).toMatchObject({ error_count: 1, timeout_count: 1, rejected_count: 1 });
  });

  test("bounds raw samples while retaining exact counts and throughput", () => {
    const recorder = sampleRecorder("jsonata-small", 1, 1);
    for (let index = 0; index < 120_000; index += 1) {
      recorder.record({ duration_ms: index % 10, ok: true });
    }
    for (let index = 0; index < 150; index += 1) {
      recorder.record({ duration_ms: 1, ok: false, outcome: "rejected" });
    }
    const summary = summarize(recorder.samples(), 1_000, recorder.totals);
    expect(summary).toMatchObject({
      count: 120_150,
      ok_count: 120_000,
      rejected_count: 150,
      sampled_count: 100_100,
      throughput_per_second: 120_000,
      percentile_label: "sufficient",
    });
    expect(summary.p95_ms).toBe(9);
  });

  test("reports historical parity separately from release capacity", () => {
    const comparison = compareManifests(manifest("baseline", [100]), manifest("candidate", [121]));
    expect(comparison.historical_parity).toBe("inconclusive");
    expect(comparison.acceptance).toBe("inconclusive");
    expect(comparison.rows[0]?.threshold.limit_ms).toBeCloseTo(115);
  });

  test("capacity requires measured throughput, tail evidence and no failures", () => {
    const samples = Array.from({ length: 10_000 }, () => ({ duration_ms: 5, ok: true }));
    expect(compareReleaseCapacity(summarize(samples, 10_000)).status).toBe("pass");
    expect(compareReleaseCapacity(summarize(samples, 200_000)).status).toBe("fail");
    expect(compareReleaseCapacity(summarize(samples.slice(0, 100), 1_000)).status).toBe(
      "inconclusive",
    );
    expect(
      compareReleaseCapacity(
        summarize([...samples, { duration_ms: 5, ok: false, outcome: "rejected" }], 10_000),
      ).status,
    ).toBe("fail");
  });

  test("a complete reference capture can pass capacity while preserving parity failure", () => {
    const baseline = manifest("baseline", []);
    const candidate = manifest("candidate", []);
    candidate.correctness.push(
      ...["money", "csv", "date", "schema", "url", "xml", "template-diff"].map((name) => ({
        name: `helper-${name}`,
        ok: true,
      })),
    );
    const names = ["js-small", "js-typical", "jsonata-small", "jsonata-typical"];
    for (const [target, count, latency] of [
      [baseline, 2_500, 1],
      [candidate, 2_000, 5],
    ] as const) {
      target.profile = {
        ...target.profile,
        name: "release",
        repeats: 5,
        concurrency: [1, 4],
        load: { mode: "closed", max_outstanding: 4 },
      };
      target.runs = names.flatMap((name) =>
        [1, 4].flatMap((concurrency) =>
          Array.from({ length: 5 }, (_, index) => ({
            ...target.runs[0]!,
            case: {
              name,
              family: name.startsWith("js-") ? ("javascript" as const) : ("jsonata" as const),
              size: name.endsWith("small") ? ("small" as const) : ("typical" as const),
            },
            repeat: index + 1,
            concurrency,
            measurement_elapsed_ms: 10_000,
            load: { mode: "closed" as const, max_outstanding: concurrency },
            samples: Array.from({ length: count }, () => ({ duration_ms: latency, ok: true })),
          })),
        ),
      );
    }
    candidate.runs = candidate.runs.map((run) => ({
      ...run,
      measurement_elapsed_ms: run.concurrency === 1 ? 50_000 : run.measurement_elapsed_ms,
    }));
    const comparison = compareManifests(baseline, candidate);
    expect(comparison.acceptance).toBe("pass");
    expect(comparison.historical_parity).toBe("fail");
    expect(comparison.rows.filter((row) => row.gated)).toHaveLength(8);
    candidate.host.reference_environment = false;
    candidate.runs = candidate.runs.map((run) => ({
      ...run,
      measurement_elapsed_ms: 50_000,
    }));
    expect(compareManifests(baseline, candidate).acceptance).toBe("inconclusive");
  });

  test("does not claim acceptance outside the reference environment", () => {
    const comparison = compareManifests(
      manifest("baseline", [100], false),
      manifest("candidate", [100], false),
    );
    expect(comparison.acceptance).toBe("inconclusive");
  });

  test("refuses comparisons between closed and open load modes", () => {
    const baseline = manifest("baseline", [100]);
    const candidate = manifest("candidate", [100]);
    candidate.profile = {
      ...candidate.profile,
      load: { mode: "open", offered_rate_per_second: 10, max_outstanding: 1 },
    };
    candidate.runs[0] = { ...candidate.runs[0]!, load: candidate.profile.load };
    const comparison = compareManifests(baseline, candidate);
    expect(comparison).toMatchObject({ comparable: false, acceptance: "inconclusive" });
  });

  test("refuses unequal measurement windows", () => {
    const baseline = manifest("baseline", [100]);
    const candidate = manifest("candidate", [100]);
    candidate.profile = { ...candidate.profile, measure_ms: 200 };
    expect(compareManifests(baseline, candidate)).toMatchObject({
      comparable: false,
      acceptance: "inconclusive",
    });
  });

  test("uses a fixed offered schedule instead of completion-paced arrivals", () => {
    expect(
      openLoopSchedule({ start_ms: 100, measure_ms: 1_000, offered_rate_per_second: 4 }),
    ).toEqual([100, 350, 600, 850]);
  });

  test("reports paired uncertainty from repeats rather than individual requests", () => {
    const baseline = manifest("baseline", [100, 100, 100]);
    const candidate = manifest("candidate", [110, 110, 110]);
    baseline.profile = { ...baseline.profile, repeats: 5 };
    candidate.profile = { ...candidate.profile, repeats: 5 };
    baseline.runs = Array.from({ length: 5 }, (_, index) => ({
      ...baseline.runs[0]!,
      repeat: index + 1,
    }));
    candidate.runs = Array.from({ length: 5 }, (_, index) => ({
      ...candidate.runs[0]!,
      repeat: index + 1,
    }));
    const ratio = compareManifests(baseline, candidate).rows[0]?.paired_p95_ratio;
    expect(ratio).toMatchObject({ estimate: 1.1, repetitions: 5, label: "sufficient" });
    expect(ratio?.ci95).toEqual({ low: 1.1, high: 1.1 });
  });

  test("calculates throughput from observed measurement time", () => {
    const baseline = manifest("baseline", [1]);
    const candidate = manifest("candidate", [1]);
    baseline.runs[0] = {
      ...baseline.runs[0]!,
      measure_ms: 100,
      measurement_elapsed_ms: 2_000,
    };
    candidate.runs[0] = {
      ...candidate.runs[0]!,
      measure_ms: 100,
      measurement_elapsed_ms: 500,
    };
    const comparison = compareManifests(baseline, candidate);
    expect(comparison.rows[0]?.baseline.throughput_per_second).toBeCloseTo(0.5);
    expect(comparison.rows[0]?.candidate.throughput_per_second).toBeCloseTo(2);
  });
});
