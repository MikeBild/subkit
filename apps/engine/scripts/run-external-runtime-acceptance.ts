import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { gitVisibleSourceDigest } from "../../../scripts/lib/source-digest.ts";
import { verificationRunsRoot } from "../../../scripts/lib/verification-run-lifecycle.ts";
import { runWithVerificationLog } from "../../../scripts/run-with-verification-log.ts";
import { externalRuntimeDockerTests } from "./audit/external-runtime-tests.ts";
import { isCanonicalRepoPath, type MutationWaveManifest } from "./audit/mutation-wave.ts";
import { loadMutationWave } from "./run-mutation-shards.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function regularEvidence(repo: string, path: string): string {
  const root = join(repo);
  const local = relative(root, path);
  if (!isCanonicalRepoPath(local)) throw new Error("external runtime evidence escapes repository");
  let cursor = root;
  for (const part of local.split("/")) {
    cursor = join(cursor, part);
    if (lstatSync(cursor).isSymbolicLink())
      throw new Error("external runtime evidence traverses symlink");
  }
  if (!lstatSync(cursor).isFile())
    throw new Error("external runtime evidence is not a regular file");
  return readFileSync(cursor, "utf8");
}

export interface ExternalRuntimeAcceptanceReceipt {
  version: 1;
  wave_id: string;
  manifest_sha256: string;
  source_sha256: string;
  test_sha256: string;
  git_source_digest: string;
  tests: readonly string[];
  commands: readonly {
    mode: "cold" | "warm";
    repeat: 5;
    exit_code: 0;
    build_index_path: string;
    build_index_sha256: string;
  }[];
}

export function validateExternalRuntimeAcceptance(
  repo: string,
  wave: MutationWaveManifest,
  manifestText: string,
  receipt: unknown,
): string[] {
  const value = receipt as Partial<ExternalRuntimeAcceptanceReceipt> | null;
  const expected = externalRuntimeDockerTests(repo);
  if (expected.length === 0) return [];
  if (!value || typeof value !== "object")
    return ["external runtime acceptance receipt is malformed"];
  const errors: string[] = [];
  if (value.version !== 1) errors.push("external runtime acceptance receipt version mismatch");
  if (value.wave_id !== wave.wave_id) errors.push("external runtime acceptance wave mismatch");
  if (value.manifest_sha256 !== hash(manifestText))
    errors.push("external runtime acceptance manifest mismatch");
  if (value.source_sha256 !== wave.source_freeze_sha256)
    errors.push("external runtime acceptance source mismatch");
  if (value.test_sha256 !== wave.test_freeze_sha256)
    errors.push("external runtime acceptance test mismatch");
  const visible = gitVisibleSourceDigest(repo);
  if (value.git_source_digest !== visible.digest)
    errors.push("external runtime acceptance git-visible source mismatch");
  if (JSON.stringify(value.tests) !== JSON.stringify(expected))
    errors.push("external runtime acceptance Docker inventory mismatch");
  const commands = value.commands;
  if (
    !Array.isArray(commands) ||
    JSON.stringify(
      commands.map((command) => [command?.mode, command?.repeat, command?.exit_code]),
    ) !==
      JSON.stringify([
        ["cold", 5, 0],
        ["warm", 5, 0],
      ])
  )
    errors.push("external runtime acceptance does not prove five cold and five warm Docker runs");
  for (const command of commands ?? []) {
    if (!isCanonicalRepoPath(command?.build_index_path)) {
      errors.push("external runtime acceptance build-index path is unsafe");
      continue;
    }
    let text: string;
    try {
      text = regularEvidence(repo, join(repo, command.build_index_path));
    } catch {
      errors.push("external runtime acceptance build-index is unavailable");
      continue;
    }
    if (hash(text) !== command.build_index_sha256) {
      errors.push("external runtime acceptance build-index hash mismatch");
      continue;
    }
    let index: {
      mode?: unknown;
      repeat?: unknown;
      tests?: unknown;
      builds?: Array<{
        attempt?: unknown;
        project?: unknown;
        image_id?: unknown;
        platform?: unknown;
        source?: { digest?: unknown };
        context_digest?: unknown;
        receipt_path?: unknown;
        receipt_sha256?: unknown;
      }>;
    };
    try {
      index = JSON.parse(text);
    } catch {
      errors.push("external runtime acceptance build-index is invalid JSON");
      continue;
    }
    if (
      index.mode !== command.mode ||
      index.repeat !== 5 ||
      JSON.stringify(index.tests) !== JSON.stringify(expected) ||
      !Array.isArray(index.builds) ||
      index.builds.length !== 5
    ) {
      errors.push("external runtime acceptance build-index does not prove five complete runs");
      continue;
    }
    const attempts = new Set<number>();
    const projects = new Set<string>();
    for (const build of index.builds) {
      if (
        typeof build.attempt !== "number" ||
        !Number.isInteger(build.attempt) ||
        build.attempt! < 1 ||
        build.attempt! > 5 ||
        attempts.has(build.attempt!) ||
        typeof build.project !== "string" ||
        projects.has(build.project) ||
        typeof build.image_id !== "string" ||
        !/^sha256:[a-f0-9]{64}$/i.test(build.image_id) ||
        typeof build.platform !== "string" ||
        !/^[a-z0-9]+\/[a-z0-9]+$/i.test(build.platform) ||
        !isCanonicalRepoPath(build.receipt_path)
      ) {
        errors.push("external runtime acceptance build identity is malformed or repeated");
        continue;
      }
      attempts.add(build.attempt!);
      projects.add(build.project);
      if (
        build.source?.digest !== value.git_source_digest ||
        typeof build.context_digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(build.context_digest) ||
        typeof build.receipt_sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(build.receipt_sha256)
      )
        errors.push("external runtime acceptance build receipt does not bind the frozen source");
      let nativeText: string;
      try {
        nativeText = regularEvidence(
          repo,
          join(repo, dirname(command.build_index_path), build.receipt_path),
        );
      } catch {
        errors.push("external runtime acceptance native build receipt is unavailable");
        continue;
      }
      if (hash(nativeText) !== build.receipt_sha256) {
        errors.push("external runtime acceptance native build receipt hash mismatch");
        continue;
      }
      let native: Record<string, unknown>;
      try {
        native = JSON.parse(nativeText);
      } catch {
        errors.push("external runtime acceptance native build receipt is invalid JSON");
        continue;
      }
      if (
        native.project !== build.project ||
        native.image_id !== build.image_id ||
        native.platform !== build.platform ||
        (native.source as { digest?: unknown } | undefined)?.digest !== build.source?.digest ||
        (native.context as { digest?: unknown } | undefined)?.digest !== build.context_digest
      )
        errors.push("external runtime acceptance native build receipt fields mismatch");
    }
    if (attempts.size !== 5 || projects.size !== 5)
      errors.push("external runtime acceptance build attempts are incomplete or nonunique");
  }
  return errors;
}

export async function executeExternalRuntimeAcceptance(input: {
  repo: string;
  manifestPath: string;
}): Promise<string | undefined> {
  const assertFrozen = () => loadMutationWave(input.repo, input.manifestPath);
  const initial = assertFrozen();
  const { wave, manifestText } = initial;
  const tests = externalRuntimeDockerTests(input.repo);
  if (tests.length === 0) return undefined;
  if (JSON.stringify(wave.external_runtime_tests) !== JSON.stringify(tests))
    throw new Error(
      "Frozen wave external runtime inventory differs from canonical Docker discovery",
    );
  const visible = gitVisibleSourceDigest(input.repo);
  const root = join(
    input.repo,
    "reports/external-runtime/runs",
    wave.wave_id,
    `run-${randomUUID()}`,
  );
  mkdirSync(root, { recursive: true });
  const commands: Array<ExternalRuntimeAcceptanceReceipt["commands"][number]> = [];
  const { SKIP_DOCKER: _skipDocker, ...environment } = process.env;
  for (const mode of ["cold", "warm"] as const) {
    assertFrozen();
    const indexPath = join(root, `${mode}.build-index.json`);
    const exitCode = await runWithVerificationLog({
      root: verificationRunsRoot(input.repo),
      owner: `external-runtime:${wave.wave_id}:${mode}:${randomUUID()}`,
      command: "bun",
      args: ["run", "test:docker", "--repeat=5", `--mode=${mode}`, `--result-index=${indexPath}`],
      cwd: input.repo,
      env: { ...environment, NODE_ENV: "test", LLM_PROVIDER: "mock" },
      retention: "pinned",
      timeoutMs: 12 * 60 * 60_000,
    });
    if (exitCode !== 0) throw new Error(`external Docker ${mode} acceptance exited ${exitCode}`);
    assertFrozen();
    const indexText = readFileSync(indexPath, "utf8");
    commands.push({
      mode,
      repeat: 5,
      exit_code: 0,
      build_index_path: relative(input.repo, indexPath),
      build_index_sha256: hash(indexText),
    });
  }
  const final = assertFrozen();
  if (final.manifestText !== manifestText)
    throw new Error("Frozen wave changed during Docker acceptance");
  if (gitVisibleSourceDigest(input.repo).digest !== visible.digest)
    throw new Error("Git-visible source changed during Docker acceptance");
  const path = join(root, "acceptance.json");
  const receipt: ExternalRuntimeAcceptanceReceipt = {
    version: 1,
    wave_id: wave.wave_id,
    manifest_sha256: hash(manifestText),
    source_sha256: wave.source_freeze_sha256,
    test_sha256: wave.test_freeze_sha256,
    git_source_digest: visible.digest,
    tests,
    commands,
  };
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
  return relative(input.repo, path);
}
