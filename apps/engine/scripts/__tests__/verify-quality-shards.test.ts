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

test("accepts independently bound raw survivors without rewriting reports or exit receipts", async () => {
  const f = qualityChainFixture(false, false, true);
  roots.push(f.root);
  const reportPath = join(f.root, f.mutationRoot, "fixture/mutation.json");
  const receiptPath = join(f.root, f.mutationRoot, "fixture/receipt.json");
  const beforeReport = readFileSync(reportPath, "utf8");
  const beforeReceipt = readFileSync(receiptPath, "utf8");
  expect(JSON.parse(beforeReceipt).exit_code).toBe(1);
  const output = await verifyQualityShards(f.options);
  const accepted = JSON.parse(readFileSync(output, "utf8"));
  expect(accepted.mutation.raw_score).toBeLessThan(100);
  expect(accepted.mutation.adjusted_score).toBe(100);
  expect(accepted.mutation.score_summary.raw_undetected).toBe(1);
  expect(accepted.mutation.score_summary.undetected).toBe(0);
  expect(accepted.mutation.score_summary.equivalent_excluded).toBe(1);
  expect(readFileSync(reportPath, "utf8")).toBe(beforeReport);
  expect(readFileSync(receiptPath, "utf8")).toBe(beforeReceipt);
});

test("raw survivor acceptance rejects error states, wrong exits and forged score claims", async () => {
  for (const variant of [
    "exit0",
    "exit2",
    "error",
    "noCoverage",
    "reason",
    "unknownSurvivor",
    "rawScore",
  ] as const) {
    const f = qualityChainFixture(false, false, true);
    roots.push(f.root);
    const reportPath = join(f.root, f.mutationRoot, "fixture/mutation.json");
    const receiptPath = join(f.root, f.mutationRoot, "fixture/receipt.json");
    const unionPath = f.options.mutationUnionPath;
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    const union = JSON.parse(readFileSync(unionPath, "utf8"));
    const target = report.files[f.targets[0]!];
    if (variant === "exit0") receipt.exit_code = 0;
    if (variant === "exit2") receipt.exit_code = 2;
    if (variant === "error") report.error = "runner failure";
    if (variant === "noCoverage") target.mutants[1].status = "NoCoverage";
    if (variant === "reason") target.mutants[1].statusReason = "unexpected reason";
    if (variant === "unknownSurvivor")
      target.mutants.push({
        status: "Survived",
        mutatorName: "BooleanLiteral",
        replacement: "different",
        location: target.mutants[1].location,
      });
    if (variant === "rawScore") union.raw_mutation_score = 100;
    const reportText = JSON.stringify(report);
    receipt.report_sha256 = hash(reportText);
    const receiptText = JSON.stringify(receipt);
    union.shards[0].receipt_sha256 = hash(receiptText);
    writeFileSync(reportPath, reportText);
    writeFileSync(receiptPath, receiptText);
    writeFileSync(unionPath, JSON.stringify(union));
    await expect(verifyQualityShards(f.options)).rejects.toThrow();
    expect(existsSync(join(f.root, "reports/quality"))).toBe(false);
  }
});

test("rejects altered independent review text against frozen equivalence evidence", async () => {
  const f = qualityChainFixture(false, false, true);
  roots.push(f.root);
  const path = join(f.root, f.wave.equivalence_manifest_path);
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.equivalents[0].independent_review = "Different review, same source and mutation";
  writeFileSync(path, JSON.stringify(manifest));
  await expect(verifyQualityShards(f.options)).rejects.toThrow();
  expect(existsSync(join(f.root, "reports/quality"))).toBe(false);
});
