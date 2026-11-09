import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCoverageRunLease,
  createDirectTargetProof,
} from "../../apps/engine/scripts/audit/coverage-artifacts.ts";
import {
  publishCoverageReceipt,
  readPublishedCoverage,
} from "../../apps/engine/scripts/audit/coverage-publication.ts";
import { exportCoverageEvidence } from "../export-quality-evidence.ts";

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "subkit-quality-export-"));
  roots.push(root);
  return { root, source: join(root, "coverage"), destination: join(root, "export") };
}

async function publish(source: string, target = "packages/shared/src/example.ts") {
  const lcov = `TN:\nSF:${target}\nFN:1,example\nFNDA:1,example\nFNF:1\nFNH:1\nDA:1,1\nLF:1\nLH:1\nend_of_record\n`;
  const proof = createDirectTargetProof(target, lcov);
  return publishCoverageReceipt({
    coverageDir: source,
    lease: createCoverageRunLease(source),
    lcov,
    provenance: {
      version: 4,
      scope: [target],
      direct_target_evidence: [{ target, path: proof.relativePath, sha256: proof.sha256 }],
    },
    directTargetProofs: [proof],
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("quality evidence export", () => {
  test("independent exporters cannot replace each other's destination", async () => {
    const { source, destination } = fixture();
    const selected = await publish(source);
    const script = `import { exportCoverageEvidence } from ${JSON.stringify(import.meta.resolve("../export-quality-evidence.ts"))}; exportCoverageEvidence(process.argv.at(-2), process.argv.at(-1));`;
    const outcomes = await Promise.all(
      [0, 1].map(async () => {
        const child = Bun.spawn([process.execPath, "-e", script, source, destination], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const [code] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        return code;
      }),
    );
    expect(outcomes.filter((code) => code === 0)).toHaveLength(1);
    expect(readPublishedCoverage(destination).runId).toBe(selected.runId);
  });

  test("exports only the selected complete run with independently verifiable direct proofs", async () => {
    const { source, destination } = fixture();
    await publish(source, "packages/shared/src/older.ts");
    const selected = await publish(source);
    writeFileSync(join(source, "unrelated.log"), "not evidence");
    expect(exportCoverageEvidence(source, destination)).toBe(selected.runId);
    expect(readdirSync(join(destination, "runs"))).toEqual([selected.runId]);
    expect(existsSync(join(destination, "raw"))).toBe(false);
    expect(existsSync(join(destination, "unrelated.log"))).toBe(false);
    rmSync(source, { recursive: true });
    const copied = readPublishedCoverage(destination);
    expect(copied.runId).toBe(selected.runId);
    expect(copied.targetProofPaths).toHaveLength(1);
    expect(readFileSync(copied.targetProofPaths[0]!, "utf8")).toContain("FNH:1");
  });

  test("rejects tampered or missing proof files without leaving an export", async () => {
    for (const corrupt of [false, true]) {
      const { root, source, destination } = fixture();
      const selected = await publish(source);
      if (corrupt) writeFileSync(selected.targetProofPaths[0]!, "tampered");
      else rmSync(selected.targetProofPaths[0]!);
      expect(() => exportCoverageEvidence(source, destination)).toThrow();
      expect(existsSync(destination)).toBe(false);
      expect(readdirSync(root).filter((path) => path.startsWith(".quality-export-"))).toEqual([]);
    }
  });

  test("preserves existing exports and refuses writing inside source evidence", async () => {
    const { source, destination } = fixture();
    await publish(source);
    mkdirSync(destination);
    writeFileSync(join(destination, "preserve"), "original");
    expect(() => exportCoverageEvidence(source, destination)).toThrow("already exists");
    expect(readFileSync(join(destination, "preserve"), "utf8")).toBe("original");
    expect(() => exportCoverageEvidence(source, source)).toThrow("outside");
    expect(() => exportCoverageEvidence(source, join(source, "nested"))).toThrow("outside");
  });
});
