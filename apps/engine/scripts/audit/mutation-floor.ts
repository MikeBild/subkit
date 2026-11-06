import { isAbsolute, relative } from "node:path/posix";

interface FileScore {
  file: string;
  detected: number;
  undetected: number;
  score: number;
}

interface MutationVerdict {
  passed: FileScore[];
  failed: FileScore[];
}

const DETECTED: ReadonlySet<string> = new Set(["Killed", "Timeout"]);
const UNDETECTED: ReadonlySet<string> = new Set(["Survived", "NoCoverage"]);

export function readBreakThreshold(config: unknown): number | null {
  if (typeof config !== "object" || config === null) return null;
  const thresholds = (config as { thresholds?: unknown }).thresholds;
  if (typeof thresholds !== "object" || thresholds === null) return null;
  const value = (thresholds as { break?: unknown }).break;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function readReportPath(config: unknown, fallback: string): string {
  if (typeof config !== "object" || config === null) return fallback;
  const reporter = (config as { jsonReporter?: unknown }).jsonReporter;
  if (typeof reporter !== "object" || reporter === null) return fallback;
  const name = (reporter as { fileName?: unknown }).fileName;
  return typeof name === "string" && name.length > 0 ? name : fallback;
}

export function normalizeReportPath(repo: string, file: string): string {
  return isAbsolute(file) ? relative(repo, file) : file.replace(/^\.\//, "");
}

export function scoreFiles(report: unknown, repo: string): FileScore[] | { error: string } {
  if (typeof report !== "object" || report === null) return { error: "report is not an object" };
  const files = (report as { files?: unknown }).files;
  if (typeof files !== "object" || files === null) return { error: "report has no files map" };
  const out: FileScore[] = [];
  for (const [file, entry] of Object.entries(files as Record<string, unknown>)) {
    const mutants = (entry as { mutants?: unknown } | null)?.mutants;
    if (!Array.isArray(mutants)) return { error: `${file} has no mutants array` };
    let detected = 0;
    let undetected = 0;
    for (const mutant of mutants) {
      const status = (mutant as { status?: unknown } | null)?.status;
      if (typeof status !== "string") continue;
      if (DETECTED.has(status)) detected += 1;
      else if (UNDETECTED.has(status)) undetected += 1;
    }
    const valid = detected + undetected;
    out.push({
      file: normalizeReportPath(repo, file),
      detected,
      undetected,
      score: valid === 0 ? 100 : (detected / valid) * 100,
    });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

export function judgeScores(scores: readonly FileScore[], threshold: number): MutationVerdict {
  const passed: FileScore[] = [];
  const failed: FileScore[] = [];
  for (const score of scores) (score.score >= threshold ? passed : failed).push(score);
  return { passed, failed };
}

export function renderScore(score: FileScore): string {
  return `${score.file}  ${score.score.toFixed(2)} % (${score.detected} detected, ${score.undetected} survived)`;
}
