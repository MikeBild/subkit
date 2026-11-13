import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { mutationInfrastructureSentinelPath } from "../audit/mutation-infrastructure-sentinel.ts";
import { mutationClosureFiles, mutationTestInputs } from "../audit/mutation-inputs.ts";
import { validateMutationValidationTicketEvidence } from "../audit/mutation-ticket-evidence.ts";
import { writeMutationValidationTicket } from "../audit/mutation-validation-ticket.ts";
import { digestCanonical, digestWaveFiles } from "../audit/mutation-wave.ts";
import { loadMutationWave } from "../run-mutation-shards.ts";
import { frozenWaveFixture, frozenWaveRuntimeSnapshot } from "./fixtures/frozen-wave.ts";

const owned: string[] = [];
afterEach(() => {
  for (const root of owned.splice(0)) rmSync(root, { recursive: true, force: true });
});

function context() {
  const f = frozenWaveFixture();
  owned.push(f.root);
  const prepared = loadMutationWave(f.root, f.manifestPath);
  const runId = "run-caller-test";
  const parentRunRoot = join(f.root, "reports/mutation/runs", f.wave.wave_id, runId);
  mkdirSync(parentRunRoot, { recursive: true });
  const copiedManifestPath = join(parentRunRoot, "wave.json");
  writeFileSync(copiedManifestPath, prepared.manifestText);
  const runtimeSnapshot = frozenWaveRuntimeSnapshot({
    root: f.root,
    parentRunRoot,
    wave: prepared.wave,
    manifestText: prepared.manifestText,
    runId,
  });
  const ticket = writeMutationValidationTicket({
    repo: f.root,
    parentRunRoot,
    copiedManifestPath,
    manifestText: prepared.manifestText,
    wave: prepared.wave,
    entries: prepared.entries,
    runtimeInputs: mutationTestInputs(f.root),
    closureFiles: mutationClosureFiles(f.root),
    runtimeSnapshot,
    runId,
  });
  const env = {
    ...process.env,
    SUBKIT_MUTATION_ORIGINAL_REPO: f.root,
    SUBKIT_MUTATION_PARENT_TICKET_PATH: ticket.path,
    SUBKIT_MUTATION_PARENT_TICKET_SHA256: ticket.sha256,
  };
  const child = (...flags: string[]) =>
    Bun.spawnSync(
      [
        "bun",
        resolve(import.meta.dir, "../run-core-tests.ts"),
        "--shard-manifest",
        copiedManifestPath,
        "--shard",
        "fixture",
        ...flags,
      ],
      { env, stdout: "pipe", stderr: "pipe" },
    );
  const list = () => child("--list");
  return { ...f, env, list, execute: () => child(), ticket, runtimeSnapshot };
}

test("the actual command child lists exactly the full parent-validated test set", () => {
  const f = context();
  const result = f.list();
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString().trim().split("\n")).toEqual(f.tests.map((path) => `./${path}`));
});

test("the actual command child rejects source changes after parent validation", () => {
  const f = context();
  f.put(f.targets[0]!, "export const changed = false;\n");
  const result = f.list();
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("differs");
  expect(result.stdout.toString()).toBe("");
});

test("the actual command child refuses a forged inherited ticket hash", () => {
  const f = context();
  f.env.SUBKIT_MUTATION_PARENT_TICKET_SHA256 = "0".repeat(64);
  const result = f.list();
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("sha256 differs");
  expect(result.stdout.toString()).toBe("");
});

test("the executing command child records a broken runtime snapshot as infrastructure failure", () => {
  const f = context();
  const sentinel = mutationInfrastructureSentinelPath(f.ticket.path);
  rmSync(join(f.runtimeSnapshot.path, "runtime-snapshot.seal.json"));
  expect(f.list().exitCode).toBe(0);
  expect(existsSync(sentinel)).toBe(false);
  const executed = f.execute();
  expect(executed.exitCode).not.toBe(0);
  expect(executed.stdout.toString()).toBe("");
  expect(existsSync(sentinel)).toBe(true);
  expect(f.execute().exitCode).not.toBe(0);
});

test("portable evidence rejects a self-consistent shortened closure inventory", () => {
  const f = context();
  const proof = {
    repo: f.root,
    wave: f.wave,
    waveText: JSON.stringify(f.wave),
    runId: "run-caller-test",
    mutationRoot: relative(f.root, dirname(f.ticket.path)),
    ticketPath: relative(f.root, f.ticket.path),
    ticketSha256: f.ticket.sha256,
    ticketText: f.ticket.text,
  };
  expect(() => validateMutationValidationTicketEvidence(proof)).not.toThrow();
  const shortened = { ...f.ticket.ticket, closure_files: f.ticket.ticket.closure_files.slice(1) };
  shortened.closure_paths_sha256 = digestCanonical(shortened.closure_files);
  shortened.closure_source_sha256 = digestWaveFiles(f.root, shortened.closure_files);
  const ticketText = `${JSON.stringify(shortened, null, 2)}\n`;
  expect(() =>
    validateMutationValidationTicketEvidence({
      ...proof,
      ticketText,
      ticketSha256: createHash("sha256").update(ticketText).digest("hex"),
    }),
  ).toThrow("current source freeze differs");
});
