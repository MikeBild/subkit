import {
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { readPublishedCoverage } from "../apps/engine/scripts/audit/coverage-publication.ts";

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw error;
    return join(canonicalPath(dirname(path)), basename(path));
  }
}

function containedPath(root: string, path: string): string {
  const local = relative(root, path);
  if (!local || local === ".." || local.startsWith("../") || isAbsolute(local)) {
    throw new Error(`Evidence path escapes its coverage directory: ${path}`);
  }
  return local;
}

export function exportCoverageEvidence(coverageDir: string, destination: string): string {
  const source = realpathSync(coverageDir);
  const output = canonicalPath(resolve(destination));
  const outputRelative = relative(source, output);
  if (!outputRelative || (!outputRelative.startsWith("../") && outputRelative !== "..")) {
    throw new Error("Evidence exports must be outside the source coverage directory");
  }
  if (pathExists(output)) throw new Error(`Evidence export already exists: ${output}`);
  const selected = readPublishedCoverage(source);
  mkdirSync(dirname(output), { recursive: true });
  const staging = mkdtempSync(join(dirname(output), ".quality-export-"));
  try {
    for (const path of [
      selected.lcovPath,
      selected.provenancePath,
      selected.receiptPath,
      ...selected.targetProofPaths,
    ]) {
      const target = join(staging, containedPath(source, path));
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(path, target, constants.COPYFILE_EXCL);
    }
    writeFileSync(join(staging, "latest.json"), selected.latestContents, { flag: "wx" });
    const copied = readPublishedCoverage(staging);
    if (copied.runId !== selected.runId) throw new Error("Exported coverage run changed");
    mkdirSync(output, { mode: 0o700 });
    renameSync(join(staging, "runs"), join(output, "runs"));
    renameSync(join(staging, "latest.json"), join(output, "latest.json"));
    return copied.runId;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--if-present")) throw new Error("Unknown export option");
  const coverageDir = resolve(import.meta.dir, "../reports/coverage");
  if (args.includes("--if-present") && !pathExists(join(coverageDir, "latest.json"))) {
    console.log("No published coverage run to export");
  } else {
    const runId = exportCoverageEvidence(
      coverageDir,
      resolve(import.meta.dir, "../reports/quality-export/coverage"),
    );
    console.log(`Exported complete coverage evidence: ${runId}`);
  }
}
