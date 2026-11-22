import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mutationWaveKind,
  planMutationRetention,
  pruneMutationReports,
} from "../audit/mutation-retention.ts";

const RELEASE_A = "release-00000000-0000-4000-8000-00000000000a";
const RELEASE_B = "release-00000000-0000-4000-8000-00000000000b";
const RELEASE_C = "release-00000000-0000-4000-8000-00000000000c";
const DAY = 24 * 60 * 60 * 1_000;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function reports(): string {
  const root = mkdtempSync(join(tmpdir(), "subkit-mutation-retention-"));
  roots.push(root);
  return root;
}

function run(
  root: string,
  wave: string,
  id: string,
  marker: "union" | "failed" | null,
  at: number,
) {
  const directory = join(root, "mutation", "runs", wave, id);
  mkdirSync(directory, { recursive: true });
  if (marker) {
    const file = join(directory, `${marker}.json`);
    writeFileSync(file, "{}\n");
    utimesSync(file, at / 1000, at / 1000);
  }
  return directory;
}

function inputs(root: string, wave: string, at: number) {
  const directory = join(root, "quality-inputs", wave);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "wave.json"), "{}\n");
  utimesSync(directory, at / 1000, at / 1000);
  return directory;
}

describe("mutation report retention", () => {
  test("release waves share one kind, named waves are their own kind", () => {
    expect(mutationWaveKind(RELEASE_A)).toBe("release");
    expect(mutationWaveKind("p1-candidate-v2")).toBe("p1-candidate-v2");
  });

  test("keeps the latest complete run per kind, pinned runs and runs in flight", () => {
    const plan = planMutationRetention({
      waves: [
        { wave: RELEASE_A, runs: [{ run: "run-a", complete: true, mtimeMs: 1 }] },
        { wave: RELEASE_B, runs: [{ run: "run-b", complete: true, mtimeMs: 2 }] },
        { wave: RELEASE_C, runs: [{ run: "run-c", complete: true, mtimeMs: 3 }] },
        {
          wave: "p1-candidate-v2",
          runs: [
            { run: "run-old", complete: true, mtimeMs: 1 },
            { run: "run-new", complete: true, mtimeMs: 5 },
            { run: "run-live", complete: false, mtimeMs: 6 },
          ],
        },
      ],
      inputs: [
        { wave: RELEASE_A, mtimeMs: 0 },
        { wave: RELEASE_B, mtimeMs: 0 },
        { wave: RELEASE_C, mtimeMs: 0 },
        { wave: "release-orphan-old", mtimeMs: 0 },
        { wave: "release-orphan-fresh", mtimeMs: 10 * DAY },
      ],
      keep: [{ wave: RELEASE_A, run: "run-a" }],
      now: 10 * DAY + 1,
    });
    expect(plan).toEqual({
      waves: [RELEASE_B],
      runs: [{ wave: "p1-candidate-v2", run: "run-old" }],
      inputs: [RELEASE_B, "release-orphan-old"],
    });
  });

  test("a wave with a run in flight is never removed as a whole", () => {
    const plan = planMutationRetention({
      waves: [
        {
          wave: RELEASE_A,
          runs: [
            { run: "run-done", complete: true, mtimeMs: 1 },
            { run: "run-live", complete: false, mtimeMs: 2 },
          ],
        },
        { wave: RELEASE_B, runs: [{ run: "run-b", complete: true, mtimeMs: 3 }] },
      ],
      inputs: [{ wave: RELEASE_A, mtimeMs: 0 }],
      keep: [],
      now: 0,
    });
    expect(plan).toEqual({
      waves: [],
      runs: [{ wave: RELEASE_A, run: "run-done" }],
      inputs: [],
    });
  });

  test("previews, then prunes on disk and never touches release receipts", () => {
    const root = reports();
    const now = Date.now();
    const old = run(root, RELEASE_A, "run-a", "union", now - 3 * DAY);
    const receipted = run(root, RELEASE_B, "run-b", "union", now - 2 * DAY);
    const latest = run(root, RELEASE_C, "run-c", "failed", now - DAY);
    const oldInputs = inputs(root, RELEASE_A, now - 3 * DAY);
    const keptInputs = inputs(root, RELEASE_C, now - DAY);
    const receipts = join(root, "mutation", "release");
    mkdirSync(receipts, { recursive: true });
    const receipt = join(receipts, `${"a".repeat(40)}.json`);
    writeFileSync(
      receipt,
      JSON.stringify({
        wave_id: RELEASE_B,
        run_id: "run-b",
        recorded_at: new Date(now - 2 * DAY).toISOString(),
      }),
    );

    expect(pruneMutationReports(root, { now: new Date(now) })).toEqual({
      waves: [RELEASE_A],
      runs: [],
      inputs: [RELEASE_A],
    });
    expect(existsSync(old)).toBe(true);

    pruneMutationReports(root, { apply: true, now: new Date(now) });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(oldInputs)).toBe(false);
    expect(existsSync(receipted)).toBe(true);
    expect(existsSync(latest)).toBe(true);
    expect(existsSync(keptInputs)).toBe(true);
    expect(existsSync(receipt)).toBe(true);
  });

  test("a checkout without reports needs no cleanup", () => {
    expect(pruneMutationReports(join(reports(), "missing"), { apply: true })).toEqual({
      waves: [],
      runs: [],
      inputs: [],
    });
  });
});
