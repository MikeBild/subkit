import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface MutationRunListing {
  run: string;
  complete: boolean;
  mtimeMs: number;
}
export interface MutationWaveListing {
  wave: string;
  runs: readonly MutationRunListing[];
}
export interface MutationRunRef {
  wave: string;
  run: string;
}
export interface QualityInputListing {
  wave: string;
  mtimeMs: number;
}
export interface MutationRetentionPlan {
  runs: MutationRunRef[];
  waves: string[];
  inputs: string[];
}

const OWNED_NAME = /^[a-z0-9][a-z0-9-]{0,119}$/;
const RELEASE_WAVE = /^release-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ABANDONED_INPUT_MS = 24 * 60 * 60 * 1_000;

export const mutationWaveKind = (wave: string): string =>
  RELEASE_WAVE.test(wave) ? "release" : wave;

const newest = (runs: readonly MutationRunListing[]): MutationRunListing | undefined =>
  runs
    .filter((run) => run.complete)
    .reduce<MutationRunListing | undefined>(
      (best, run) =>
        !best || run.mtimeMs > best.mtimeMs || (run.mtimeMs === best.mtimeMs && run.run > best.run)
          ? run
          : best,
      undefined,
    );

export function planMutationRetention(input: {
  waves: readonly MutationWaveListing[];
  inputs: readonly QualityInputListing[];
  keep: readonly MutationRunRef[];
  now: number;
}): MutationRetentionPlan {
  const pinned = new Set(input.keep.map((ref) => `${ref.wave}/${ref.run}`));
  const latestByKind = new Map<string, { wave: string; run: MutationRunListing }>();
  for (const wave of input.waves) {
    const run = newest(wave.runs);
    if (!run) continue;
    const kind = mutationWaveKind(wave.wave);
    const current = latestByKind.get(kind);
    if (!current || run.mtimeMs > current.run.mtimeMs)
      latestByKind.set(kind, { wave: wave.wave, run });
  }
  for (const latest of latestByKind.values()) pinned.add(`${latest.wave}/${latest.run.run}`);
  const keptWaves = new Set([...pinned].map((ref) => ref.slice(0, ref.indexOf("/"))));
  const plan: MutationRetentionPlan = { runs: [], waves: [], inputs: [] };
  for (const wave of input.waves) {
    const removable = wave.runs.filter(
      (run) => run.complete && !pinned.has(`${wave.wave}/${run.run}`),
    );
    if (!keptWaves.has(wave.wave) && removable.length === wave.runs.length) {
      plan.waves.push(wave.wave);
      continue;
    }
    plan.runs.push(...removable.map((run) => ({ wave: wave.wave, run: run.run })));
  }
  const removedWaves = new Set(plan.waves);
  const knownWaves = new Set(input.waves.map((wave) => wave.wave));
  for (const entry of input.inputs) {
    if (keptWaves.has(entry.wave)) continue;
    if (removedWaves.has(entry.wave)) plan.inputs.push(entry.wave);
    else if (!knownWaves.has(entry.wave) && input.now - entry.mtimeMs > ABANDONED_INPUT_MS)
      plan.inputs.push(entry.wave);
  }
  plan.runs.sort((a, b) => `${a.wave}/${a.run}`.localeCompare(`${b.wave}/${b.run}`));
  plan.waves.sort();
  plan.inputs.sort();
  return plan;
}

const ownedDirectories = (root: string): { name: string; mtimeMs: number }[] => {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && !entry.isSymbolicLink() && OWNED_NAME.test(entry.name),
    )
    .map((entry) => ({ name: entry.name, mtimeMs: lstatSync(join(root, entry.name)).mtimeMs }));
};

const runComplete = (directory: string): boolean =>
  existsSync(join(directory, "union.json")) || existsSync(join(directory, "failed.json"));

export function listMutationReports(reports: string): {
  waves: MutationWaveListing[];
  inputs: QualityInputListing[];
} {
  const runsRoot = join(reports, "mutation", "runs");
  const waves = ownedDirectories(runsRoot).map(({ name }) => ({
    wave: name,
    runs: ownedDirectories(join(runsRoot, name)).map((run) => {
      const directory = join(runsRoot, name, run.name);
      const complete = runComplete(directory);
      const marker = join(
        directory,
        existsSync(join(directory, "union.json")) ? "union.json" : "failed.json",
      );
      return {
        run: run.name,
        complete,
        mtimeMs: complete ? lstatSync(marker).mtimeMs : run.mtimeMs,
      };
    }),
  }));
  const inputs = ownedDirectories(join(reports, "quality-inputs")).map((entry) => ({
    wave: entry.name,
    mtimeMs: entry.mtimeMs,
  }));
  return { waves, inputs };
}

export function releaseReceiptRuns(reports: string): MutationRunRef[] {
  const directory = join(reports, "mutation", "release");
  if (!existsSync(directory)) return [];
  const receipts = readdirSync(directory)
    .filter((name) => /^[0-9a-f]{40}\.json$/.test(name))
    .flatMap((name) => {
      try {
        const receipt = JSON.parse(readFileSync(join(directory, name), "utf8")) as {
          wave_id?: unknown;
          run_id?: unknown;
          recorded_at?: unknown;
        };
        const recorded = Date.parse(String(receipt.recorded_at));
        return typeof receipt.wave_id === "string" &&
          typeof receipt.run_id === "string" &&
          Number.isFinite(recorded)
          ? [{ wave: receipt.wave_id, run: receipt.run_id, recorded }]
          : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.recorded - a.recorded);
  return receipts.slice(0, 1).map(({ wave, run }) => ({ wave, run }));
}

function removeOwned(parent: string, name: string): void {
  if (!OWNED_NAME.test(name)) throw new Error(`refusing to remove unowned report entry: ${name}`);
  const original = join(parent, name);
  const stat = lstatSync(original, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return;
  const claimed = join(parent, `.${name}.pruning-${randomUUID()}`);
  renameSync(original, claimed);
  rmSync(claimed, { recursive: true, force: true, maxRetries: 1 });
}

export function pruneMutationReports(
  reports: string,
  options: { keep?: readonly MutationRunRef[]; apply?: boolean; now?: Date } = {},
): MutationRetentionPlan {
  const listing = listMutationReports(reports);
  const plan = planMutationRetention({
    ...listing,
    keep: [...(options.keep ?? []), ...releaseReceiptRuns(reports)],
    now: (options.now ?? new Date()).getTime(),
  });
  if (!options.apply) return plan;
  const runsRoot = join(reports, "mutation", "runs");
  for (const ref of plan.runs) {
    const directory = join(runsRoot, ref.wave, ref.run);
    if (runComplete(directory)) removeOwned(join(runsRoot, ref.wave), ref.run);
  }
  for (const wave of plan.waves) {
    const directory = join(runsRoot, wave);
    if (ownedDirectories(directory).every((run) => runComplete(join(directory, run.name))))
      removeOwned(runsRoot, wave);
  }
  for (const wave of plan.inputs) removeOwned(join(reports, "quality-inputs"), wave);
  return plan;
}
