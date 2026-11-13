import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { qualityChainFixture } from "../../apps/engine/scripts/__tests__/fixtures/quality-chain.ts";
import {
  mutationClosureFiles,
  mutationTestInputs,
} from "../../apps/engine/scripts/audit/mutation-inputs.ts";
import { writeMutationValidationTicket } from "../../apps/engine/scripts/audit/mutation-validation-ticket.ts";
import { assertCompletePureTargetInventory } from "../../apps/engine/scripts/audit/pure-targets.ts";
import { exportShardQualityEvidence } from "../export-shard-quality-evidence.ts";
import { verifyShardQualityBundle } from "../verify-shard-quality-bundle.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

function bindParentTicket(source: ReturnType<typeof qualityChainFixture>): void {
  const manifestPath = join(source.root, source.mutationRoot, "wave.json");
  const manifestText = readFileSync(manifestPath, "utf8");
  const ticket = writeMutationValidationTicket({
    repo: source.root,
    parentRunRoot: join(source.root, source.mutationRoot),
    copiedManifestPath: manifestPath,
    manifestText,
    wave: source.wave,
    entries: assertCompletePureTargetInventory(source.targets),
    runId: "run-mutation",
    runtimeInputs: mutationTestInputs(source.root),
    closureFiles: mutationClosureFiles(source.root),
    runtimeSnapshot: { ...source.runtimeSnapshot, sealSha256: source.runtimeSnapshotSeal },
  });
  for (const shard of source.wave.shards) {
    const receiptPath = join(source.root, source.mutationRoot, shard.id, "receipt.json");
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
    receipt.parent_validation_ticket_path = `${source.mutationRoot}/mutation-validation-ticket.json`;
    receipt.parent_validation_ticket_sha256 = ticket.sha256;
    writeFileSync(receiptPath, JSON.stringify(receipt));
  }
  const unionPath = join(source.root, source.mutationRoot, "union.json");
  const union = JSON.parse(readFileSync(unionPath, "utf8")) as {
    shards: Array<{ id: string; receipt_sha256: string }>;
  };
  for (const shard of union.shards)
    shard.receipt_sha256 = hash(
      readFileSync(join(source.root, source.mutationRoot, shard.id, "receipt.json"), "utf8"),
    );
  writeFileSync(unionPath, JSON.stringify(union));
}

test("complete policy-bound evidence survives another checkout and rejects changed proof bytes", async () => {
  const source = qualityChainFixture(true, true, false, true);
  const transfer = realpathSync(mkdtempSync(join(tmpdir(), "subkit-quality-transfer-")));
  const git = (cwd: string, args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    bindParentTicket(source);
    writeFileSync(join(source.root, ".gitignore"), "reports/\n.artifacts/\nquality-bundle.json\n");
    git(source.root, ["init", "--quiet"]);
    git(source.root, ["add", "."]);
    git(source.root, [
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
    const commit = git(source.root, ["rev-parse", "HEAD"]);
    const rejectedBundle = join(transfer, "missing-external-receipt");
    await expect(
      exportShardQualityEvidence({ ...source.options, destination: rejectedBundle }),
    ).rejects.toThrow("requires external runtime acceptance evidence");
    expect(existsSync(rejectedBundle)).toBe(false);
    const externalRuntimeAcceptancePath = source.createExternalRuntimeAcceptance();
    const bundle = join(transfer, "bundle");
    const indexPath = await exportShardQualityEvidence({
      ...source.options,
      externalRuntimeAcceptancePath,
      destination: bundle,
    });
    const index = JSON.parse(readFileSync(indexPath, "utf8")) as {
      files: { path: string }[];
      commit_sha: string;
    };
    expect(index.commit_sha).toBe(commit);
    expect(
      index.files.some(
        (file) => file.path.includes(".artifacts/behavior/") && file.path.endsWith("runner.log"),
      ),
    ).toBe(true);
    expect(
      index.files.filter((file) => file.path.includes(".build-index.json.receipts/")).length,
    ).toBe(10);
    expect(index.files.some((file) => file.path === externalRuntimeAcceptancePath)).toBe(true);
    expect(index.files.some((file) => file.path.endsWith("mutation-validation-ticket.json"))).toBe(
      true,
    );
    expect(
      index.files.some(
        (file) => file.path.includes(".artifacts/behavior/") && file.path.endsWith("result.json"),
      ),
    ).toBe(true);
    const checkout = join(transfer, "checkout");
    git(transfer, ["clone", "--quiet", "--no-hardlinks", source.root, checkout]);
    cpSync(bundle, checkout, { recursive: true });
    const nestedIndex = "reports/quality-export/shards/quality-bundle.json";
    const nestedDirectory = join(checkout, "reports/quality-export/shards");
    mkdirSync(nestedDirectory, { recursive: true });
    cpSync(join(bundle, "quality-bundle.json"), join(checkout, nestedIndex));
    const accepted = await verifyShardQualityBundle(checkout, commit, nestedIndex);
    expect(JSON.parse(readFileSync(accepted, "utf8")).mutation.score).toBe(100);
    await expect(verifyShardQualityBundle(checkout, "b".repeat(40), nestedIndex)).rejects.toThrow(
      "Release checkout does not match expected commit",
    );
    rmSync(join(checkout, nestedIndex));
    await expect(verifyShardQualityBundle(checkout, commit, nestedIndex)).rejects.toThrow(
      "Run `bun run verify:quality:release-shards` first",
    );
    cpSync(join(bundle, "quality-bundle.json"), join(checkout, nestedIndex));
    const parentTicket = index.files.find((file) =>
      file.path.endsWith("mutation-validation-ticket.json"),
    )!;
    writeFileSync(join(checkout, parentTicket.path), "{}");
    await expect(verifyShardQualityBundle(checkout, commit)).rejects.toThrow(
      "Quality bundle file changed",
    );
    cpSync(join(bundle, parentTicket.path), join(checkout, parentTicket.path));
    rmSync(join(checkout, parentTicket.path));
    await expect(verifyShardQualityBundle(checkout, commit)).rejects.toThrow();
    cpSync(join(bundle, parentTicket.path), join(checkout, parentTicket.path));
    const proof = index.files.find((file) => file.path.endsWith(".lcov"))!;
    writeFileSync(join(checkout, proof.path), "tampered");
    await expect(verifyShardQualityBundle(checkout, commit)).rejects.toThrow(
      "Quality bundle file changed",
    );
  } finally {
    rmSync(source.root, { recursive: true, force: true });
    rmSync(transfer, { recursive: true, force: true });
  }
}, 30_000);
