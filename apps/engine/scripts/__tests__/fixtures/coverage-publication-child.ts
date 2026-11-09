import {
  createCoverageRunLease,
  createDirectTargetProof,
  installCoverageLeaseSignalRetention,
  publishCoverageReceipt,
} from "../../audit/coverage-artifacts.ts";

const [coverageDir, target, mode] = process.argv.slice(2);
if (!coverageDir || !target || !mode) throw new Error("expected coverageDir, target, mode");
const lcov = `TN:\nSF:${target}\nFN:1,one\nFNDA:1,one\nFNF:1\nFNH:1\nDA:1,1\nLF:1\nLH:1\nend_of_record\n`;
const lease = createCoverageRunLease(coverageDir);
if (mode === "signal") {
  installCoverageLeaseSignalRetention(lease);
  process.kill(process.pid, "SIGTERM");
  await Bun.sleep(1_000);
} else {
  const proof = createDirectTargetProof(target, lcov);
  await publishCoverageReceipt({
    coverageDir,
    lease,
    lcov,
    provenance: {
      version: 4,
      direct_target_evidence: [{ target, path: proof.relativePath, sha256: proof.sha256 }],
    },
    directTargetProofs: [proof],
  });
}
