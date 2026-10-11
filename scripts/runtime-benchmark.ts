import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { BenchmarkManifest, BenchmarkProfileName } from "./runtime-benchmark/model.ts";
import { writeComparison } from "./runtime-benchmark/report.ts";
import { captureBenchmark, profiles } from "./runtime-benchmark/runner.ts";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

export async function readManifest(path: string): Promise<BenchmarkManifest> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as
    | BenchmarkManifest
    | {
        schema?: string;
        profile?: string;
        captured_at?: string;
        host?: { platform: string; arch: string; bun: string; cpus: number };
        runtime?: string;
        runs?: Record<string, Array<{ duration_ms: number; ok: boolean; error?: string }>>;
      };
  if (parsed.schema === "subkit-runtime-benchmark") return parsed;
  if (parsed.schema === "subkit-runtime-benchmark-raw" && parsed.runs && parsed.host) {
    const capturedAt = parsed.captured_at ?? new Date(0).toISOString();
    return {
      schema: "subkit-runtime-benchmark",
      label: parsed.runtime ?? "baseline",
      profile: {
        name: "smoke",
        warmup_ms: 0,
        measure_ms: 0,
        repeats: 1,
        concurrency: [1],
        load: { mode: "closed", max_outstanding: 1 },
      },
      started_at: capturedAt,
      finished_at: capturedAt,
      host: {
        platform: parsed.host.platform,
        arch: parsed.host.arch,
        bun: parsed.host.bun,
        cpu_count: parsed.host.cpus,
        memory_bytes: 0,
        reference_environment: false,
        reference_gap: "legacy capture lacks reference machine metadata",
      },
      source_root: "frozen baseline probe",
      source_sha256: "unavailable-legacy-capture",
      lockfile_sha256: "unavailable-legacy-capture",
      runs: Object.entries(parsed.runs).map(([name, samples]) => ({
        case: {
          name,
          family: name.startsWith("js-") ? "javascript" : "jsonata",
          size: name.endsWith("small") ? "small" : "typical",
        },
        repeat: 1,
        concurrency: 1,
        warmup_ms: 0,
        measure_ms: 0,
        measurement_elapsed_ms: 0,
        load: { mode: "closed", max_outstanding: 1 },
        samples,
        process_memory: { before_rss_bytes: 0, after_rss_bytes: 0, peak_rss_bytes: 0 },
      })),
      correctness: [{ name: "legacy-capture", ok: true }],
    };
  }
  throw new Error(`unsupported benchmark manifest: ${path}`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "capture") {
    const profileName = (option("--profile") ?? "smoke") as BenchmarkProfileName;
    const profile = profiles[profileName];
    const output = option("--output");
    if (!profile || !output)
      throw new Error("capture requires --profile smoke|release|full and --output path");
    const repeats = Number(option("--repeats") ?? profile?.repeats);
    if (!Number.isInteger(repeats) || repeats < 1)
      throw new Error("--repeats must be a positive integer");
    const mode = option("--load") ?? "closed";
    if (mode !== "closed" && mode !== "open") throw new Error("--load must be closed or open");
    const offeredRate = option("--offered-rate");
    const parsedRate = offeredRate === undefined ? undefined : Number(offeredRate);
    if (mode === "open" && (!Number.isFinite(parsedRate) || (parsedRate ?? 0) <= 0)) {
      throw new Error("open-loop capture requires a positive --offered-rate");
    }
    const maxOutstanding = Number(option("--max-outstanding") ?? profile.load.max_outstanding);
    if (!Number.isInteger(maxOutstanding) || maxOutstanding < 1) {
      throw new Error("--max-outstanding must be a positive integer");
    }
    const manifest = await captureBenchmark({
      label: option("--label") ?? "candidate",
      profile: {
        ...profile,
        repeats,
        load: {
          mode,
          max_outstanding: maxOutstanding,
          ...(mode === "open" ? { offered_rate_per_second: parsedRate } : {}),
        },
      },
      sourceRoot: resolve(option("--source") ?? process.cwd()),
      requireHelpers: process.argv.includes("--require-helpers"),
    });
    await mkdir(dirname(resolve(output)), { recursive: true });
    await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`${output}\n`);
    if (manifest.correctness.some((check) => !check.ok)) process.exitCode = 1;
    return;
  }
  if (command === "paired") {
    const profileName = (option("--profile") ?? "smoke") as BenchmarkProfileName;
    const profile = profiles[profileName];
    const baselineSource = option("--baseline-source");
    const candidateSource = option("--candidate-source");
    const output = option("--output");
    if (!profile || !baselineSource || !candidateSource || !output)
      throw new Error(
        "paired requires --profile, --baseline-source, --candidate-source and --output",
      );
    const repeats = Number(option("--repeats") ?? profile.repeats);
    if (!Number.isInteger(repeats) || repeats < 1)
      throw new Error("--repeats must be a positive integer");
    const mode = option("--load") ?? "closed";
    if (mode !== "closed" && mode !== "open") throw new Error("--load must be closed or open");
    const offeredRate = option("--offered-rate");
    const parsedRate = offeredRate === undefined ? undefined : Number(offeredRate);
    if (mode === "open" && (!Number.isFinite(parsedRate) || (parsedRate ?? 0) <= 0)) {
      throw new Error("open-loop paired capture requires a positive --offered-rate");
    }
    const maxOutstanding = Number(option("--max-outstanding") ?? profile.load.max_outstanding);
    if (!Number.isInteger(maxOutstanding) || maxOutstanding < 1) {
      throw new Error("--max-outstanding must be a positive integer");
    }
    const pairedProfile = {
      ...profile,
      repeats,
      load: {
        mode,
        max_outstanding: maxOutstanding,
        ...(mode === "open" ? { offered_rate_per_second: parsedRate } : {}),
      },
    } as typeof profile;
    const outputDir = resolve(output);
    await mkdir(outputDir, { recursive: true });
    const captures: Record<"baseline" | "candidate", BenchmarkManifest[]> = {
      baseline: [],
      candidate: [],
    };
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      const order: Array<readonly ["baseline" | "candidate", string]> = [
        ["baseline", baselineSource],
        ["candidate", candidateSource],
      ];
      if (repeat % 2 === 0) order.reverse();
      for (const [label, source] of order) {
        const path = `${outputDir}/${label}-${repeat}.json`;
        const child = Bun.spawn([
          process.execPath,
          import.meta.path,
          "capture",
          "--profile",
          profile.name,
          "--repeats",
          "1",
          "--label",
          label,
          "--source",
          source,
          "--output",
          path,
          "--load",
          mode,
          "--max-outstanding",
          String(maxOutstanding),
          ...(offeredRate ? ["--offered-rate", offeredRate] : []),
          ...(label === "candidate" ? ["--require-helpers"] : []),
        ]);
        if ((await child.exited) !== 0) throw new Error(`${label} capture ${repeat} failed`);
        const captured = await readManifest(path);
        captures[label].push({
          ...captured,
          runs: captured.runs.map((run) => ({ ...run, repeat })),
        });
      }
    }
    const combine = (label: "baseline" | "candidate"): BenchmarkManifest => {
      const first = captures[label][0];
      if (!first) throw new Error("paired capture missing manifest");
      for (const captured of captures[label]) {
        if (
          captured.source_sha256 !== first.source_sha256 ||
          captured.lockfile_sha256 !== first.lockfile_sha256 ||
          JSON.stringify(captured.host) !== JSON.stringify(first.host) ||
          JSON.stringify(captured.profile) !== JSON.stringify(first.profile)
        ) {
          throw new Error(`${label} source, lockfile, host or profile changed during capture`);
        }
      }
      const last = captures[label].at(-1);
      return {
        ...first,
        finished_at: last?.finished_at ?? first.finished_at,
        profile: pairedProfile,
        runs: captures[label].flatMap((manifest) => manifest.runs),
        correctness: captures[label].flatMap((manifest) => manifest.correctness),
      };
    };
    const baseline = combine("baseline");
    const candidate = combine("candidate");
    await writeFile(`${outputDir}/baseline.json`, `${JSON.stringify(baseline, null, 2)}\n`);
    await writeFile(`${outputDir}/candidate.json`, `${JSON.stringify(candidate, null, 2)}\n`);
    const comparison = await writeComparison({
      baseline,
      candidate,
      output: outputDir,
      baselinePath: `${outputDir}/baseline.json`,
      candidatePath: `${outputDir}/candidate.json`,
    });
    process.stdout.write(`${comparison.acceptance}\n`);
    if (comparison.acceptance !== "pass") process.exitCode = 1;
    return;
  }
  if (command === "compare") {
    const baseline = option("--baseline");
    const candidate = option("--candidate");
    const output = option("--output");
    if (!baseline || !candidate || !output)
      throw new Error("compare requires --baseline, --candidate and --output");
    const comparison = await writeComparison({
      baseline: await readManifest(baseline),
      candidate: await readManifest(candidate),
      output,
      baselinePath: resolve(baseline),
      candidatePath: resolve(candidate),
    });
    process.stdout.write(`${comparison.acceptance}\n`);
    if (comparison.acceptance !== "pass") process.exitCode = 1;
    return;
  }
  throw new Error("usage: runtime-benchmark capture|paired|compare");
}

if (import.meta.main) await main();
