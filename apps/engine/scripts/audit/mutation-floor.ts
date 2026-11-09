import { createHash } from "node:crypto";
import { isAbsolute, posix, relative } from "node:path";

interface FileScore {
  file: string;
  detected: number;
  undetected: number;
  score: number;
  equivalent_excluded?: number;
}

interface MutationVerdict {
  passed: FileScore[];
  failed: FileScore[];
}

const DETECTED: ReadonlySet<string> = new Set(["Killed", "Timeout"]);
const UNDETECTED: ReadonlySet<string> = new Set(["Survived", "NoCoverage"]);

export interface MutationEquivalent {
  file: string;
  source_sha256: string;
  location: { start: { line: number; column: number }; end: { line: number; column: number } };
  mutatorName: string;
  replacement: string;
  original: string;
  statusReason: string;
  reason: string;
  independent_review: string;
}

export interface MutationEquivalentManifest {
  version: number;
  equivalents: MutationEquivalent[];
}

interface EquivalentMatch {
  file: string;
  mutant: unknown;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function sameLocation(left: unknown, right: unknown): boolean {
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null)
    return false;
  const location = left as Partial<MutationEquivalent["location"]>;
  const mutantLocation = right as Partial<MutationEquivalent["location"]>;
  return (
    isPositiveInteger(location.start?.line) &&
    isPositiveInteger(location.start?.column) &&
    isPositiveInteger(location.end?.line) &&
    isPositiveInteger(location.end?.column) &&
    isPositiveInteger(mutantLocation.start?.line) &&
    isPositiveInteger(mutantLocation.start?.column) &&
    isPositiveInteger(mutantLocation.end?.line) &&
    isPositiveInteger(mutantLocation.end?.column) &&
    location.start.line === mutantLocation.start.line &&
    location.start.column === mutantLocation.start.column &&
    location.end.line === mutantLocation.end.line &&
    location.end.column === mutantLocation.end.column
  );
}

function equivalentKey(entry: MutationEquivalent): string {
  return JSON.stringify([
    entry.file,
    entry.source_sha256,
    entry.location.start.line,
    entry.location.start.column,
    entry.location.end.line,
    entry.location.end.column,
    entry.mutatorName,
    entry.replacement,
    entry.statusReason,
  ]);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceSlice(source: string, location: MutationEquivalent["location"]): string | null {
  const lines = source.split("\n");
  const { start, end } = location;
  if (start.line > lines.length || end.line > lines.length || start.line > end.line) return null;
  if (
    start.column > lines[start.line - 1]!.length + 1 ||
    end.column > lines[end.line - 1]!.length + 1
  )
    return null;
  const offset = (line: number, column: number) =>
    lines.slice(0, line - 1).reduce((total, entry) => total + entry.length + 1, 0) + column - 1;
  const from = offset(start.line, start.column);
  const to = offset(end.line, end.column);
  return to >= from ? source.slice(from, to) : null;
}

function canonicalManifestFile(repo: string, file: unknown): string | null {
  if (typeof file !== "string" || file.length === 0 || posix.isAbsolute(file)) return null;
  if (
    file.includes("\\") ||
    file.startsWith("./") ||
    posix.normalize(file) !== file ||
    file.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  )
    return null;
  const normalized = normalizeReportPath(repo, file);
  return normalized === file && !normalized.startsWith("../") ? normalized : null;
}

export function readMutationEquivalentManifest(
  value: unknown,
  repo: string,
): MutationEquivalentManifest | { error: string } {
  if (typeof value !== "object" || value === null)
    return { error: "equivalence manifest is not an object" };
  const manifest = value as Partial<MutationEquivalentManifest>;
  if (manifest.version !== 1) return { error: "equivalence manifest has unsupported version" };
  if (!Array.isArray(manifest.equivalents))
    return { error: "equivalence manifest has no equivalents array" };
  const equivalents: MutationEquivalent[] = [];
  for (const [index, raw] of manifest.equivalents.entries()) {
    if (typeof raw !== "object" || raw === null)
      return { error: `equivalence manifest entry ${index} is not an object` };
    const entry = raw as Partial<MutationEquivalent>;
    const file = canonicalManifestFile(repo, entry.file);
    const location = entry.location;
    if (!file) return { error: `equivalence manifest entry ${index} has a non-canonical file` };
    if (
      typeof entry.source_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.source_sha256) ||
      typeof entry.mutatorName !== "string" ||
      entry.mutatorName.length === 0 ||
      typeof entry.replacement !== "string" ||
      typeof entry.original !== "string" ||
      entry.original.length === 0 ||
      typeof entry.statusReason !== "string" ||
      entry.statusReason.length === 0 ||
      typeof entry.reason !== "string" ||
      entry.reason.trim().length === 0 ||
      typeof entry.independent_review !== "string" ||
      entry.independent_review.trim().length === 0 ||
      !location ||
      !isPositiveInteger(location.start?.line) ||
      !isPositiveInteger(location.start?.column) ||
      !isPositiveInteger(location.end?.line) ||
      !isPositiveInteger(location.end?.column)
    )
      return { error: `equivalence manifest entry ${index} is malformed` };
    equivalents.push({
      file,
      location,
      source_sha256: entry.source_sha256,
      mutatorName: entry.mutatorName,
      replacement: entry.replacement,
      original: entry.original,
      statusReason: entry.statusReason,
      reason: entry.reason,
      independent_review: entry.independent_review,
    });
  }
  return { version: 1, equivalents };
}

export function validateMutationEquivalents(input: {
  report: unknown;
  manifest: MutationEquivalentManifest;
  repo: string;
  expectedScope: readonly string[];
  sourceSha256ForFile: (file: string) => string | null;
}): { errors: string[]; matches: EquivalentMatch[] } {
  const errors: string[] = [];
  const matches: EquivalentMatch[] = [];
  const scope = new Set(input.expectedScope);
  const usedMutants = new Set<unknown>();
  const files = (input.report as { files?: Record<string, unknown> } | null)?.files;
  if (!files || typeof files !== "object") return { errors: ["report has no files map"], matches };
  const seen = new Set<string>();
  for (const entry of input.manifest.equivalents) {
    const key = equivalentKey(entry);
    if (seen.has(key)) {
      errors.push(`equivalence manifest has duplicate entry for ${entry.file}`);
      continue;
    }
    seen.add(key);
    if (!scope.has(entry.file)) {
      errors.push(`equivalence manifest file is outside the declared pure scope: ${entry.file}`);
      continue;
    }
    const actualSource = input.sourceSha256ForFile(entry.file);
    if (actualSource !== entry.source_sha256) {
      errors.push(`equivalence manifest source hash does not match current file: ${entry.file}`);
      continue;
    }
    const reportEntry = Object.entries(files).find(
      ([file]) => normalizeReportPath(input.repo, file) === entry.file,
    )?.[1] as { source?: unknown; mutants?: unknown } | undefined;
    if (!reportEntry || typeof reportEntry.source !== "string") {
      errors.push(`equivalence manifest file is missing report source: ${entry.file}`);
      continue;
    }
    if (sha256(reportEntry.source) !== entry.source_sha256) {
      errors.push(`equivalence manifest source hash does not match report source: ${entry.file}`);
      continue;
    }
    if (sourceSlice(reportEntry.source, entry.location) !== entry.original) {
      errors.push(
        `equivalence manifest original does not match report source range: ${entry.file}`,
      );
      continue;
    }
    if (!Array.isArray(reportEntry.mutants)) {
      errors.push(`equivalence manifest file has no report mutants: ${entry.file}`);
      continue;
    }
    const found = reportEntry.mutants.filter((mutant) => {
      const value = mutant as {
        status?: unknown;
        mutatorName?: unknown;
        replacement?: unknown;
        statusReason?: unknown;
        location?: unknown;
      } | null;
      return (
        value?.status === "Ignored" &&
        value.mutatorName === entry.mutatorName &&
        value.replacement === entry.replacement &&
        value.statusReason === entry.statusReason &&
        sameLocation(entry.location, value.location)
      );
    });
    if (found.length !== 1) {
      errors.push(`equivalence manifest entry is not matched exactly once: ${entry.file}`);
      continue;
    }
    if (usedMutants.has(found[0])) {
      errors.push(`equivalence manifest entries map to the same ignored mutant: ${entry.file}`);
      continue;
    }
    usedMutants.add(found[0]);
    matches.push({ file: entry.file, mutant: found[0] });
  }
  const matched = new Set(matches.map((match) => match.mutant));
  for (const [file, raw] of Object.entries(files)) {
    const entry = raw as { mutants?: unknown } | null;
    if (!Array.isArray(entry?.mutants)) continue;
    for (const mutant of entry.mutants) {
      if ((mutant as { status?: unknown } | null)?.status === "Ignored" && !matched.has(mutant))
        errors.push(
          `ignored mutant is not registered exactly: ${normalizeReportPath(input.repo, file)}`,
        );
    }
  }
  return { errors, matches };
}

export function readBreakThreshold(config: unknown): number | null {
  if (typeof config !== "object" || config === null) return null;
  const thresholds = (config as { thresholds?: unknown }).thresholds;
  if (typeof thresholds !== "object" || thresholds === null) return null;
  const value = (thresholds as { break?: unknown }).break;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function validateMutationThresholds(config: unknown): string[] {
  if (typeof config !== "object" || config === null)
    return ["stryker.config.json has no thresholds object"];
  const thresholds = (config as { thresholds?: unknown }).thresholds;
  if (typeof thresholds !== "object" || thresholds === null)
    return ["stryker.config.json has no thresholds object"];
  const values = thresholds as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of ["break", "high", "low"] as const)
    if (values[key] !== 100) errors.push(`stryker.config.json thresholds.${key} must equal 100`);
  return errors;
}

const CANONICAL_TEST_COMMAND = "bun run apps/engine/scripts/run-core-tests.ts";

function emptyExcludedMutations(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length === 0);
}

function falseOrAbsent(value: unknown): boolean {
  return value === undefined || value === false;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export function validateMutationRunConfig(input: { config: unknown; report: unknown }): string[] {
  const errors: string[] = [];
  const config = asObject(input.config);
  const reportConfig = asObject(asObject(input.report)?.config);
  if (!config) return ["stryker.config.json is not an object"];
  if (!reportConfig) return ["mutation report has no config object"];
  const check = (value: Record<string, unknown>, label: string) => {
    if (!emptyExcludedMutations(value.excludedMutations))
      errors.push(`${label} top-level excludedMutations must be absent or []`);
    const mutator = value.mutator;
    if (mutator !== undefined && mutator !== null && !asObject(mutator))
      errors.push(`${label} mutator must be an object, null, or absent`);
    else if (asObject(mutator) && !emptyExcludedMutations(asObject(mutator)?.excludedMutations))
      errors.push(`${label} mutator.excludedMutations must be absent or []`);
    if (!falseOrAbsent(value.ignoreStatic))
      errors.push(`${label} ignoreStatic must be absent or false`);
    if (asObject(value.thresholds)?.break !== 100)
      errors.push(`${label} thresholds.break must equal 100`);
    if (value.testRunner !== "command") errors.push(`${label} testRunner must equal command`);
    if (asObject(value.commandRunner)?.command !== CANONICAL_TEST_COMMAND)
      errors.push(`${label} commandRunner.command must equal the canonical core test command`);
    if (value.incremental !== false) errors.push(`${label} incremental must equal false`);
    if (value.coverageAnalysis !== "off") errors.push(`${label} coverageAnalysis must equal off`);
  };
  check(config, "stryker.config.json");
  check(reportConfig, "mutation report config");
  return errors;
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

export function scoreFiles(
  report: unknown,
  repo: string,
  equivalentMutants: readonly unknown[] = [],
): FileScore[] | { error: string } {
  if (typeof report !== "object" || report === null) return { error: "report is not an object" };
  const files = (report as { files?: unknown }).files;
  if (typeof files !== "object" || files === null) return { error: "report has no files map" };
  const out: FileScore[] = [];
  for (const [file, entry] of Object.entries(files as Record<string, unknown>)) {
    const mutants = (entry as { mutants?: unknown } | null)?.mutants;
    if (!Array.isArray(mutants)) return { error: `${file} has no mutants array` };
    let detected = 0;
    let undetected = 0;
    let equivalentExcluded = 0;
    for (const mutant of mutants) {
      const status = (mutant as { status?: unknown } | null)?.status;
      if (status === "Ignored" && equivalentMutants.includes(mutant)) {
        equivalentExcluded += 1;
        continue;
      }
      if (typeof status !== "string") return { error: `${file} has a mutant without a status` };
      if (DETECTED.has(status)) detected += 1;
      else if (UNDETECTED.has(status)) undetected += 1;
      else return { error: `${file} has non-terminal mutant status ${status}` };
    }
    const valid = detected + undetected;
    const score: FileScore = {
      file: normalizeReportPath(repo, file),
      detected,
      undetected,
      score: valid === 0 ? 100 : (detected / valid) * 100,
    };
    if (equivalentExcluded > 0) score.equivalent_excluded = equivalentExcluded;
    out.push(score);
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
  const equivalent = score.equivalent_excluded
    ? `, ${score.equivalent_excluded} equivalent excluded`
    : "";
  return `${score.file}  ${score.score.toFixed(2)} % (${score.detected} detected, ${score.undetected} survived${equivalent})`;
}

export interface MutationReceipt {
  version: number;
  created_at: string;
  config_sha256: string;
  source_sha256: string;
  test_sha256: string;
  scope: string[];
  type_only_scope?: string[];
  canonical_target_count: number;
  canonical_target_sha256: string;
}

function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? [...value].sort()
    : null;
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function reportErrors(report: unknown): string[] {
  if (typeof report !== "object" || report === null) return [];
  const value = report as { error?: unknown; errors?: unknown };
  const errors: string[] = [];
  if (value.error !== undefined) {
    if (typeof value.error === "string") errors.push(value.error);
    else errors.push("mutation report error field is malformed");
  }
  if (Array.isArray(value.errors)) {
    for (const error of value.errors) {
      if (typeof error === "string" && error.length > 0) errors.push(error);
      else errors.push("mutation report contains a non-string error");
    }
  } else if (value.errors !== undefined) {
    errors.push("mutation report errors field is malformed");
  }
  return errors;
}

export function mutationReportScope(report: unknown, repo: string): string[] | { error: string } {
  if (typeof report !== "object" || report === null) return { error: "report is not an object" };
  const files = (report as { files?: unknown }).files;
  if (typeof files !== "object" || files === null) return { error: "report has no files map" };
  return Object.keys(files)
    .map((file) => normalizeReportPath(repo, file))
    .sort();
}

export function validateMutationProvenance(input: {
  report: unknown;
  receipt: unknown;
  expectedScope: readonly string[];
  expectedMutate: readonly string[];
  configSha256: string;
  sourceSha256: string;
  testSha256: string;
  canonicalTargetCount: number;
  canonicalTargetSha256: string;
  expectedTypeOnlyScope?: readonly string[];
  repo: string;
}): string[] {
  const errors = reportErrors(input.report).map((error) => `mutation report error: ${error}`);
  const expected = [...input.expectedScope].sort();
  const reportScope = mutationReportScope(input.report, input.repo);
  if ("error" in reportScope) errors.push(reportScope.error);
  else if (!samePaths(reportScope, expected))
    errors.push("mutation report scope does not match the declared pure scope");

  const receipt = input.receipt as Partial<MutationReceipt> | null;
  if (!receipt || typeof receipt !== "object")
    return [...errors, "mutation provenance receipt is invalid"];
  const receiptScope = strings(receipt.scope);
  if (!receiptScope || !samePaths(receiptScope, expected))
    errors.push("mutation receipt scope does not match the declared pure scope");
  if (input.expectedTypeOnlyScope !== undefined) {
    const typeOnlyScope = strings(receipt.type_only_scope);
    if (!typeOnlyScope || !samePaths(typeOnlyScope, [...input.expectedTypeOnlyScope].sort()))
      errors.push("mutation receipt type-only scope does not match the canonical classification");
  }
  if (receipt.config_sha256 !== input.configSha256)
    errors.push("mutation receipt was prepared with a different Stryker config");
  if (receipt.source_sha256 !== input.sourceSha256)
    errors.push("mutation source changed after the receipt was prepared");
  if (receipt.test_sha256 !== input.testSha256)
    errors.push("mutation tests, runner or lockfile changed after the receipt was prepared");
  if (receipt.canonical_target_count !== input.canonicalTargetCount)
    errors.push("mutation canonical target count changed after the receipt was prepared");
  if (receipt.canonical_target_sha256 !== input.canonicalTargetSha256)
    errors.push("mutation canonical target metadata changed after the receipt was prepared");

  const reportConfig = (input.report as { config?: { mutate?: unknown } } | null)?.config;
  const reportMutate = strings(reportConfig?.mutate);
  if (!reportMutate) errors.push("mutation report has no configured mutate scope");
  else if (!samePaths(reportMutate, [...input.expectedMutate].sort()))
    errors.push("mutation report was run with a different Stryker mutate scope");
  return errors;
}
