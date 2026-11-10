import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  packQualityArtifacts,
  restoreQualityArtifacts,
} from "../audit/distributed-quality-artifacts.ts";

const owned: string[] = [];
const identity = { commit: "a".repeat(40), githubRunId: "1", ticketSha256: "b".repeat(64) };
const root = () => {
  const path = mkdtempSync(join(tmpdir(), "quality-artifacts-"));
  owned.push(path);
  return path;
};
afterEach(() => {
  for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("artifact package restores only hash-bound evidence", () => {
  const repo = root(),
    destination = join(root(), "package"),
    restored = root();
  mkdirSync(join(repo, "reports/a"), { recursive: true });
  writeFileSync(join(repo, "reports/a/proof.json"), "proof");
  packQualityArtifacts({ repo, destination, files: ["reports/a/proof.json"], identity });
  expect(
    restoreQualityArtifacts({ repo: restored, source: destination, expectedIdentity: identity }),
  ).toEqual([join(restored, "reports/a/proof.json")]);
});

test("artifact package rejects path escape, foreign identity, tamper, and conflict", () => {
  const repo = root(),
    destination = root(),
    restored = root();
  mkdirSync(join(repo, "reports/a"), { recursive: true });
  writeFileSync(join(repo, "reports/a/proof.json"), "proof");
  expect(() =>
    packQualityArtifacts({ repo, destination, files: ["../secret"], identity }),
  ).toThrow();
  packQualityArtifacts({
    repo,
    destination: join(destination, "package"),
    files: ["reports/a/proof.json"],
    identity,
  });
  expect(() =>
    restoreQualityArtifacts({
      repo: restored,
      source: join(destination, "package"),
      expectedIdentity: { ...identity, githubRunId: "2" },
    }),
  ).toThrow("foreign");
  writeFileSync(join(destination, "package/files/reports/a/proof.json"), "tampered");
  expect(() =>
    restoreQualityArtifacts({
      repo: restored,
      source: join(destination, "package"),
      expectedIdentity: identity,
    }),
  ).toThrow("hash");
});

test("artifact package never overwrites conflicting evidence", () => {
  const repo = root(),
    destination = join(root(), "package"),
    restored = root();
  mkdirSync(join(repo, "reports/a"), { recursive: true });
  writeFileSync(join(repo, "reports/a/proof.json"), "proof");
  packQualityArtifacts({ repo, destination, files: ["reports/a/proof.json"], identity });
  mkdirSync(join(restored, "reports/a"), { recursive: true });
  writeFileSync(join(restored, "reports/a/proof.json"), "other");
  expect(() =>
    restoreQualityArtifacts({ repo: restored, source: destination, expectedIdentity: identity }),
  ).toThrow("conflicts");
});

test("artifact package rejects a missing manifest file before restore", () => {
  const repo = root(),
    destination = join(root(), "package"),
    restored = root();
  mkdirSync(join(repo, "reports/a"), { recursive: true });
  writeFileSync(join(repo, "reports/a/proof.json"), "proof");
  packQualityArtifacts({ repo, destination, files: ["reports/a/proof.json"], identity });
  unlinkSync(join(destination, "files/reports/a/proof.json"));
  expect(() =>
    restoreQualityArtifacts({ repo: restored, source: destination, expectedIdentity: identity }),
  ).toThrow();
});

test("two shard packages restore portable native evidence without host-local paths", () => {
  const hostA = root(),
    hostB = root(),
    packageA = join(root(), "alpha"),
    packageB = join(root(), "beta"),
    collector = root();
  for (const [host, shard] of [
    [hostA, "alpha"],
    [hostB, "beta"],
  ] as const) {
    const base = join(host, "reports/mutation/runs/wave-1/run-mutation-1", shard);
    mkdirSync(join(host, "reports/coverage/shards/wave-1/run-coverage-1", shard, "coverage"), {
      recursive: true,
    });
    mkdirSync(base, { recursive: true });
    mkdirSync(join(host, "reports/quality-inputs/distributed"), { recursive: true });
    writeFileSync(join(host, "reports/quality-inputs/distributed/wave.json"), "frozen-wave");
    writeFileSync(
      join(host, "reports/coverage/shards/wave-1/run-coverage-1", shard, "receipt.json"),
      `coverage-${shard}`,
    );
    writeFileSync(
      join(host, "reports/coverage/shards/wave-1/run-coverage-1", shard, "coverage/latest.json"),
      `native-${shard}`,
    );
    writeFileSync(join(base, "receipt.json"), `mutation-${shard}`);
    writeFileSync(join(base, "stryker.json"), `config-${shard}`);
    writeFileSync(join(base, "mutation.json"), `report-${shard}`);
    writeFileSync(
      join(host, "reports/mutation/runs/wave-1/run-mutation-1/mutation-validation-ticket.json"),
      `/private/${shard}`,
    );
    packQualityArtifacts({
      repo: host,
      destination: shard === "alpha" ? packageA : packageB,
      files: [
        "reports/quality-inputs/distributed/wave.json",
        `reports/coverage/shards/wave-1/run-coverage-1/${shard}/receipt.json`,
        `reports/coverage/shards/wave-1/run-coverage-1/${shard}/coverage/latest.json`,
        `reports/mutation/runs/wave-1/run-mutation-1/${shard}/receipt.json`,
        `reports/mutation/runs/wave-1/run-mutation-1/${shard}/stryker.json`,
        `reports/mutation/runs/wave-1/run-mutation-1/${shard}/mutation.json`,
      ],
      identity,
    });
  }
  restoreQualityArtifacts({ repo: collector, source: packageA, expectedIdentity: identity });
  restoreQualityArtifacts({ repo: collector, source: packageB, expectedIdentity: identity });
  expect(
    readFileSync(
      join(collector, "reports/mutation/runs/wave-1/run-mutation-1/alpha/mutation.json"),
      "utf8",
    ),
  ).toBe("report-alpha");
  expect(
    readFileSync(
      join(collector, "reports/mutation/runs/wave-1/run-mutation-1/beta/mutation.json"),
      "utf8",
    ),
  ).toBe("report-beta");
  expect(
    existsSync(
      join(
        collector,
        "reports/mutation/runs/wave-1/run-mutation-1/mutation-validation-ticket.json",
      ),
    ),
  ).toBe(false);
  expect(() =>
    restoreQualityArtifacts({
      repo: root(),
      source: packageA,
      expectedIdentity: { ...identity, githubRunId: "9" },
    }),
  ).toThrow("foreign");
  writeFileSync(
    join(packageB, "files/reports/mutation/runs/wave-1/run-mutation-1/beta/mutation.json"),
    "tamper",
  );
  expect(() =>
    restoreQualityArtifacts({ repo: root(), source: packageB, expectedIdentity: identity }),
  ).toThrow("hash");
});
