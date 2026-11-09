import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifyQualityShards } from "../verify-quality-shards.ts";
import { qualityChainFixture } from "./fixtures/quality-chain.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

function fixture() {
  const f = qualityChainFixture();
  roots.push(f.root);
  return f;
}

function releaseFixtureWithExternalRuntime() {
  const f = qualityChainFixture(true, true);
  roots.push(f.root);
  writeFileSync(join(f.root, ".gitignore"), "reports/\n.artifacts/\n");
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: f.root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "--quiet"]);
  git(["add", "."]);
  git([
    "-c",
    "user.name=Quality Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "quality fixture",
  ]);
  return f;
}

test("pairs complete on-disk mutation and native coverage chains into one acceptance", async () => {
  const f = fixture();
  const output = await verifyQualityShards(f.options);
  const receipt = JSON.parse(readFileSync(output, "utf8"));
  expect(receipt.mutation.score).toBe(100);
  expect(receipt.coverage).toMatchObject({ line: 100, function: 100 });
  expect(receipt.source_sha256).toBe(f.wave.source_freeze_sha256);
});

test("refuses tampered, missing, stale and mismatched disk evidence without publishing acceptance", async () => {
  for (const change of [
    "report",
    "proof",
    "missing",
    "source",
    "wave",
    "manifest",
    "receipt",
  ] as const) {
    const f = fixture();
    if (change === "report") f.put(`${f.mutationRoot}/fixture/mutation.json`, "{}");
    if (change === "proof")
      f.put(`${f.nativeRoot}/targets/${hash(f.targets[0]!)}.lcov`, "tampered");
    if (change === "missing") rmSync(join(f.root, f.coverageRoot, "fixture/receipt.json"));
    if (change === "source") f.put(f.targets[0]!, "export const changed = true;");
    if (change === "wave")
      f.put(
        `${f.coverageRoot}/union.json`,
        JSON.stringify({ wave_id: "other", manifest_sha256: hash(JSON.stringify(f.wave)) }),
      );
    if (change === "manifest") f.put(`${f.coverageRoot}/wave.json`, "{}");
    if (change === "receipt") {
      const path = `${f.coverageRoot}/fixture/receipt.json`;
      const receipt = JSON.parse(readFileSync(join(f.root, path), "utf8"));
      receipt.coverage_config_sha256 = hash("different config");
      f.put(path, JSON.stringify(receipt));
    }
    await expect(verifyQualityShards(f.options)).rejects.toThrow();
    expect(existsSync(join(f.root, "reports/quality"))).toBe(false);
  }
});

test("release refuses otherwise valid legacy evidence without a versioned policy", async () => {
  const f = fixture();
  await expect(verifyQualityShards({ ...f.options, requireVersionedPolicy: true })).rejects.toThrow(
    "Release quality proof requires a versioned policy-bound wave",
  );
  expect(existsSync(join(f.root, "reports/quality"))).toBe(false);
});

test("release refuses an external-runtime wave until all ten native receipts are supplied", async () => {
  const f = releaseFixtureWithExternalRuntime();
  await expect(verifyQualityShards({ ...f.options, requireVersionedPolicy: true })).rejects.toThrow(
    "requires external runtime acceptance evidence",
  );
  expect(existsSync(join(f.root, "reports/quality"))).toBe(false);

  const externalRuntimeAcceptancePath = f.createExternalRuntimeAcceptance();
  const output = await verifyQualityShards({
    ...f.options,
    requireVersionedPolicy: true,
    externalRuntimeAcceptancePath,
  });
  const receipt = JSON.parse(readFileSync(output, "utf8"));
  expect(receipt.external_runtime_acceptance.path).toBe(externalRuntimeAcceptancePath);
});
