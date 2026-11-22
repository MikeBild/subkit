import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createMutationRuntimeSnapshot,
  MUTATION_RUNTIME_ARTIFACTS,
  mutationRuntimeArtifactDigest,
  provisionMutationRuntimeSnapshot,
  sealMutationRuntimeSnapshot,
} from "../audit/mutation-runtime-snapshot.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "subkit-mutation-runtime-snapshot-")));
  roots.push(root);
  for (const path of MUTATION_RUNTIME_ARTIFACTS) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `fixture:${path}\n`);
  }
  chmodSync(join(root, "dist/subkit"), 0o755);
  const sourceFreezeSha256 = mutationRuntimeArtifactDigest(root);
  const parentRunRoot = join(root, ".reports/mutation/runs/wave-1/run-1");
  mkdirSync(parentRunRoot, { recursive: true });
  return { root, parentRunRoot, sourceFreezeSha256 };
}

test("snapshots immutable runtime artifacts once and provisions only sandbox links", () => {
  const f = fixture();
  const snapshot = createMutationRuntimeSnapshot({
    repo: f.root,
    parentRunRoot: f.parentRunRoot,
    waveId: "wave-1",
    runId: "run-1",
    sourceFreezeSha256: f.sourceFreezeSha256,
    manifestSha256: "a".repeat(64),
    artifactDigestSha256: f.sourceFreezeSha256,
  });
  const sandbox = join(f.root, "sandbox");
  mkdirSync(sandbox);
  const sealSha256 = sealMutationRuntimeSnapshot({
    path: snapshot.path,
    sha256: snapshot.sha256,
    expected: {
      wave_id: "wave-1",
      run_id: "run-1",
      source_freeze_sha256: f.sourceFreezeSha256,
      manifest_sha256: "a".repeat(64),
      artifact_digest_sha256: snapshot.snapshot.artifact_digest_sha256,
    },
  });
  provisionMutationRuntimeSnapshot({
    sandboxRepo: sandbox,
    snapshotPath: snapshot.path,
    snapshotSha256: snapshot.sha256,
    sealSha256,
    expected: {
      wave_id: "wave-1",
      run_id: "run-1",
      source_freeze_sha256: f.sourceFreezeSha256,
      manifest_sha256: "a".repeat(64),
      artifact_digest_sha256: snapshot.snapshot.artifact_digest_sha256,
    },
  });
  for (const path of MUTATION_RUNTIME_ARTIFACTS) {
    expect(lstatSync(join(sandbox, path)).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(sandbox, path), "utf8")).toBe(`fixture:${path}\n`);
  }
  provisionMutationRuntimeSnapshot({
    sandboxRepo: sandbox,
    snapshotPath: snapshot.path,
    snapshotSha256: snapshot.sha256,
    sealSha256,
    expected: {
      wave_id: "wave-1",
      run_id: "run-1",
      source_freeze_sha256: f.sourceFreezeSha256,
      manifest_sha256: "a".repeat(64),
      artifact_digest_sha256: snapshot.snapshot.artifact_digest_sha256,
    },
  });
  expect(lstatSync(join(snapshot.path, "dist/subkit")).isSymbolicLink()).toBe(false);
  expect(lstatSync(join(snapshot.path, "dist/subkit")).nlink).toBe(1);
  chmodSync(join(snapshot.path, "runtime-snapshot.seal.json"), 0o644);
  writeFileSync(join(snapshot.path, "runtime-snapshot.seal.json"), "{}\n");
  const secondSandbox = join(f.root, "second-sandbox");
  mkdirSync(secondSandbox);
  expect(() =>
    provisionMutationRuntimeSnapshot({
      sandboxRepo: secondSandbox,
      snapshotPath: snapshot.path,
      snapshotSha256: snapshot.sha256,
      sealSha256,
      expected: {
        wave_id: "wave-1",
        run_id: "run-1",
        source_freeze_sha256: f.sourceFreezeSha256,
        manifest_sha256: "a".repeat(64),
        artifact_digest_sha256: snapshot.snapshot.artifact_digest_sha256,
      },
    }),
  ).toThrow("seal differs");
});

test("fails closed when a required runtime artifact is absent or stale", () => {
  const f = fixture();
  rmSync(join(f.root, "dist/subkit"));
  expect(() =>
    createMutationRuntimeSnapshot({
      repo: f.root,
      parentRunRoot: f.parentRunRoot,
      waveId: "wave-1",
      runId: "run-1",
      sourceFreezeSha256: f.sourceFreezeSha256,
      manifestSha256: "a".repeat(64),
      artifactDigestSha256: f.sourceFreezeSha256,
    }),
  ).toThrow("ENOENT");

  writeFileSync(join(f.root, "dist/subkit"), "replacement\n");
  chmodSync(join(f.root, "dist/subkit"), 0o755);
  const current = mutationRuntimeArtifactDigest(f.root);
  const snapshot = createMutationRuntimeSnapshot({
    repo: f.root,
    parentRunRoot: f.parentRunRoot,
    waveId: "wave-1",
    runId: "run-1",
    sourceFreezeSha256: current,
    manifestSha256: "a".repeat(64),
    artifactDigestSha256: current,
  });
  chmodSync(join(snapshot.path, "dist/subkit"), 0o644);
  writeFileSync(join(snapshot.path, "dist/subkit"), "tampered\n");
  const sandbox = join(f.root, "sandbox");
  mkdirSync(sandbox);
  expect(() =>
    provisionMutationRuntimeSnapshot({
      sandboxRepo: sandbox,
      snapshotPath: snapshot.path,
      snapshotSha256: snapshot.sha256,
      expected: {
        wave_id: "wave-1",
        run_id: "run-1",
        source_freeze_sha256: current,
        manifest_sha256: "a".repeat(64),
        artifact_digest_sha256: snapshot.snapshot.artifact_digest_sha256,
      },
    }),
  ).toThrow("size differs");
  expect(existsSync(join(sandbox, "dist/subkit"))).toBe(false);
});

test("rejects snapshots bound to a different campaign before sandbox provisioning", () => {
  const f = fixture();
  const snapshot = createMutationRuntimeSnapshot({
    repo: f.root,
    parentRunRoot: f.parentRunRoot,
    waveId: "wave-1",
    runId: "run-1",
    sourceFreezeSha256: f.sourceFreezeSha256,
    manifestSha256: "a".repeat(64),
    artifactDigestSha256: f.sourceFreezeSha256,
  });
  const sandbox = join(f.root, "sandbox");
  mkdirSync(sandbox);
  expect(() =>
    provisionMutationRuntimeSnapshot({
      sandboxRepo: sandbox,
      snapshotPath: snapshot.path,
      snapshotSha256: snapshot.sha256,
      expected: {
        wave_id: "wave-1",
        run_id: "other-run",
        source_freeze_sha256: f.sourceFreezeSha256,
        manifest_sha256: "a".repeat(64),
        artifact_digest_sha256: snapshot.snapshot.artifact_digest_sha256,
      },
    }),
  ).toThrow("run_id differs");
});

test("rejects source artifacts reachable through a hardlink", () => {
  const f = fixture();
  const artifact = join(f.root, "dist/subkit");
  const linked = join(f.root, "dist/subkit-linked");
  linkSync(artifact, linked);
  rmSync(artifact);
  linkSync(linked, artifact);
  expect(() => mutationRuntimeArtifactDigest(f.root)).toThrow("must not be hardlinked");
});

test("rejects a pre-existing non-snapshot sandbox artifact", () => {
  const f = fixture();
  const snapshot = createMutationRuntimeSnapshot({
    repo: f.root,
    parentRunRoot: f.parentRunRoot,
    waveId: "wave-1",
    runId: "run-1",
    sourceFreezeSha256: f.sourceFreezeSha256,
    manifestSha256: "a".repeat(64),
    artifactDigestSha256: f.sourceFreezeSha256,
  });
  const sandbox = join(f.root, "sandbox");
  mkdirSync(dirname(join(sandbox, "dist/subkit")), { recursive: true });
  writeFileSync(join(sandbox, "dist/subkit"), "foreign\n");
  expect(() =>
    provisionMutationRuntimeSnapshot({
      sandboxRepo: sandbox,
      snapshotPath: snapshot.path,
      snapshotSha256: snapshot.sha256,
      expected: {
        wave_id: "wave-1",
        run_id: "run-1",
        source_freeze_sha256: f.sourceFreezeSha256,
        manifest_sha256: "a".repeat(64),
        artifact_digest_sha256: snapshot.snapshot.artifact_digest_sha256,
      },
    }),
  ).toThrow("already exists");
});

test("rejects a foreign file inside the snapshot before sandbox provisioning", () => {
  const f = fixture();
  const snapshot = createMutationRuntimeSnapshot({
    repo: f.root,
    parentRunRoot: f.parentRunRoot,
    waveId: "wave-1",
    runId: "run-1",
    sourceFreezeSha256: f.sourceFreezeSha256,
    manifestSha256: "a".repeat(64),
    artifactDigestSha256: f.sourceFreezeSha256,
  });
  const expected = {
    wave_id: "wave-1",
    run_id: "run-1",
    source_freeze_sha256: f.sourceFreezeSha256,
    manifest_sha256: "a".repeat(64),
    artifact_digest_sha256: snapshot.snapshot.artifact_digest_sha256,
  };
  const sealSha256 = sealMutationRuntimeSnapshot({
    path: snapshot.path,
    sha256: snapshot.sha256,
    expected,
  });
  writeFileSync(join(snapshot.path, "dist/foreign"), "foreign\n");
  const sandbox = join(f.root, "sandbox");
  mkdirSync(sandbox);
  expect(() =>
    provisionMutationRuntimeSnapshot({
      sandboxRepo: sandbox,
      snapshotPath: snapshot.path,
      snapshotSha256: snapshot.sha256,
      sealSha256,
      expected,
    }),
  ).toThrow("unexpected entry dist/foreign");
  expect(existsSync(join(sandbox, "dist/subkit"))).toBe(false);
});

test("rejects an existing seal that does not cover every snapshot artifact", () => {
  const f = fixture();
  const snapshot = createMutationRuntimeSnapshot({
    repo: f.root,
    parentRunRoot: f.parentRunRoot,
    waveId: "wave-1",
    runId: "run-1",
    sourceFreezeSha256: f.sourceFreezeSha256,
    manifestSha256: "a".repeat(64),
    artifactDigestSha256: f.sourceFreezeSha256,
  });
  const input = {
    path: snapshot.path,
    sha256: snapshot.sha256,
    expected: {
      wave_id: "wave-1",
      run_id: "run-1",
      source_freeze_sha256: f.sourceFreezeSha256,
      manifest_sha256: "a".repeat(64),
      artifact_digest_sha256: snapshot.snapshot.artifact_digest_sha256,
    },
  };
  const sealPath = join(snapshot.path, "runtime-snapshot.seal.json");
  const sealSha256 = sealMutationRuntimeSnapshot(input);
  expect(sealMutationRuntimeSnapshot(input)).toBe(sealSha256);
  const seal = JSON.parse(readFileSync(sealPath, "utf8")) as { artifacts: unknown[] };
  seal.artifacts = seal.artifacts.map(() => seal.artifacts[0]);
  chmodSync(sealPath, 0o644);
  writeFileSync(sealPath, `${JSON.stringify(seal, null, 2)}\n`);
  expect(() => sealMutationRuntimeSnapshot(input)).toThrow("runtime snapshot seal differs");
});
