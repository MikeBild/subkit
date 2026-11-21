import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { isCorePath } from "./rules.ts";

export type PureTargetKind = "engine_core" | "cockpit" | "engine_explicit" | "sk" | "shared";
export type PureTargetRuntimeKind = "runtime" | "type_only";

export interface PureTargetEntry {
  path: string;
  owner_shard: string;
  subsystem: string;
  target_kind: PureTargetKind;
  eligibility: "eligible";
  source_of_inclusion: "isCorePath" | "explicit_manifest";
  public_facade_obligations: readonly string[];
  effect_ledger_status: "required";
  runtime_kind: PureTargetRuntimeKind;
}

const REPO = resolve(import.meta.dir, "../../../..");

function typeOnlyImport(statement: ts.ImportDeclaration): boolean {
  const clause = statement.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  return (
    !clause.name &&
    clause.namedBindings !== undefined &&
    ts.isNamedImports(clause.namedBindings) &&
    clause.namedBindings.elements.length > 0 &&
    clause.namedBindings.elements.every((element) => element.isTypeOnly)
  );
}

function typeOnlyExport(statement: ts.ExportDeclaration): boolean {
  if (statement.isTypeOnly) return true;
  return (
    statement.exportClause !== undefined &&
    ts.isNamedExports(statement.exportClause) &&
    statement.exportClause.elements.length > 0 &&
    statement.exportClause.elements.every((element) => element.isTypeOnly)
  );
}

export function classifyPureTargetSource(
  source: string,
  path = "target.ts",
): PureTargetRuntimeKind {
  const scriptKind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind);
  const diagnostics = (file as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] })
    .parseDiagnostics;
  if (diagnostics && diagnostics.length > 0) return "runtime";
  for (const statement of file.statements) {
    if (
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      (ts.isImportDeclaration(statement) && typeOnlyImport(statement)) ||
      (ts.isExportDeclaration(statement) && typeOnlyExport(statement)) ||
      (ts.isImportEqualsDeclaration(statement) && statement.isTypeOnly)
    )
      continue;
    return "runtime";
  }
  return "type_only";
}

export function pureTargetSourceReader(repo: string): (path: string) => string | null {
  return (path) => {
    const absolute = resolve(repo, path);
    return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
  };
}

const defaultReadText = pureTargetSourceReader(REPO);

function subsystemFor(path: string): string {
  if (path.startsWith("apps/engine/src/"))
    return path.slice("apps/engine/src/".length).split("/")[0]!;
  if (path.startsWith("apps/cockpit/src/")) return "cockpit";
  if (path.startsWith("apps/sk/src/")) return "sk";
  if (path.startsWith("packages/shared/src/")) return "shared";
  if (path.startsWith("packages/cli-core/src/")) return "cli-core";
  return "unknown";
}

interface ExplicitPureTarget {
  path: string;
  target_kind: Exclude<PureTargetKind, "engine_core">;
}

const EXPLICIT_PURE_TARGETS: readonly ExplicitPureTarget[] = [
  { path: "apps/cockpit/src/pages/core/attention-navigation.ts", target_kind: "cockpit" },
  { path: "apps/cockpit/src/lib/core/authority-view.ts", target_kind: "cockpit" },
  { path: "apps/cockpit/src/lib/core/audit-evidence.ts", target_kind: "cockpit" },
  { path: "apps/cockpit/src/pages/core/attention-projection.ts", target_kind: "cockpit" },
  { path: "apps/cockpit/src/pages/core/run-outcome.ts", target_kind: "cockpit" },
  { path: "apps/cockpit/src/pages/core/decision-queue.ts", target_kind: "cockpit" },
  { path: "apps/cockpit/src/pages/core/decision-facts.ts", target_kind: "cockpit" },
  { path: "packages/shared/src/workflow-review-environment.ts", target_kind: "shared" },
  { path: "packages/shared/src/ux-gating.ts", target_kind: "shared" },
  { path: "packages/shared/src/suggest-next-reasons.ts", target_kind: "shared" },
  { path: "packages/shared/src/conversation-reference.ts", target_kind: "shared" },
  { path: "packages/shared/src/connector-operation-error.ts", target_kind: "shared" },
  { path: "packages/shared/src/audit-source.ts", target_kind: "shared" },
  { path: "packages/cli-core/src/message-parts.ts", target_kind: "shared" },
  { path: "packages/cli-core/src/turn-event-model.ts", target_kind: "shared" },
  { path: "packages/cli-core/src/errors-facts.ts", target_kind: "shared" },
  { path: "apps/sk/src/commands/workflow-save-model.ts", target_kind: "sk" },
  { path: "apps/sk/src/commands/connector-save-model.ts", target_kind: "sk" },
  { path: "apps/cockpit/src/lib/core/identifier.ts", target_kind: "cockpit" },
  { path: "apps/cockpit/src/lib/core/automation-presentation.ts", target_kind: "cockpit" },
  { path: "apps/cockpit/src/lib/core/authority-decision.ts", target_kind: "cockpit" },
  { path: "apps/cockpit/src/lib/core/audit-filter.ts", target_kind: "cockpit" },
  { path: "apps/cockpit/src/pages/core/runs-filter.ts", target_kind: "cockpit" },
  { path: "apps/cockpit/src/pages/audit-filter-state.ts", target_kind: "cockpit" },
  { path: "apps/cockpit/src/pages/audit-labels.ts", target_kind: "cockpit" },
  { path: "apps/cockpit/src/lib/knowledge-source-request.ts", target_kind: "cockpit" },
  { path: "apps/engine/src/workflows/draft-projection.ts", target_kind: "engine_explicit" },
  { path: "apps/sk/src/domain/agent/agent-file.ts", target_kind: "sk" },
  { path: "apps/sk/src/commands/workflow-file-model.ts", target_kind: "sk" },
  { path: "packages/cli-core/src/errors-classification.ts", target_kind: "shared" },
  { path: "packages/cli-core/src/format-render.ts", target_kind: "shared" },
  { path: "packages/shared/src/approval-choice.ts", target_kind: "shared" },
  { path: "packages/shared/src/elicitation-constants.ts", target_kind: "shared" },
  { path: "packages/shared/src/graphql-url.ts", target_kind: "shared" },
  { path: "packages/shared/src/invoke-snippet.ts", target_kind: "shared" },
  { path: "packages/shared/src/llms-index.ts", target_kind: "shared" },
  { path: "packages/shared/src/redaction.ts", target_kind: "shared" },
  { path: "packages/shared/src/side-effects.ts", target_kind: "shared" },
  { path: "packages/shared/src/validation-result.ts", target_kind: "shared" },
  { path: "packages/shared/src/workflow-automation.ts", target_kind: "shared" },
  { path: "packages/shared/src/workflow-operating-status.ts", target_kind: "shared" },
  { path: "packages/shared/src/workflow-review-target.ts", target_kind: "shared" },
  { path: "packages/shared/src/workflow-strip.ts", target_kind: "shared" },
];

export const REVIEWED_ENGINE_CORE_TARGET_PATHS = [
  "apps/engine/src/connectors/core/http-request.ts",
  "apps/engine/src/conversations/core/auto-persist.ts",
  "apps/engine/src/conversations/core/draft.ts",
  "apps/engine/src/conversations/core/dry-run.ts",
  "apps/engine/src/conversations/core/fast-path.ts",
  "apps/engine/src/conversations/core/loop.ts",
  "apps/engine/src/conversations/core/template-placeholders.ts",
  "apps/engine/src/conversations/core/tool-invoke.ts",
  "apps/engine/src/execution/core/admission.ts",
  "apps/engine/src/execution/core/run.ts",
  "apps/engine/src/execution/core/status.ts",
  "apps/engine/src/execution/use-cases/core/run-workflow.ts",
  "apps/engine/src/workflows/core/authority.ts",
  "apps/engine/src/workflows/core/definition.ts",
  "apps/engine/src/workflows/core/loop-rewrite.ts",
  "apps/engine/src/workflows/core/review-receipt.ts",
  "apps/engine/src/workflows/core/spec.ts",
  "apps/engine/src/workflows/core/workflow.ts",
] as const;

export const EXPLICIT_PURE_TARGET_PATHS = EXPLICIT_PURE_TARGETS.map(({ path }) => path);

function entry(
  path: string,
  target_kind: PureTargetKind,
  source_of_inclusion: PureTargetEntry["source_of_inclusion"],
  source: string | null,
): PureTargetEntry {
  return {
    path,
    owner_shard: subsystemFor(path),
    subsystem: subsystemFor(path),
    target_kind,
    eligibility: "eligible",
    source_of_inclusion,
    public_facade_obligations: [],
    effect_ledger_status: "required",
    runtime_kind: source === null ? "runtime" : classifyPureTargetSource(source, path),
  };
}

export function discoverPureTargets(
  files: readonly string[],
  readText: (path: string) => string | null = defaultReadText,
): PureTargetEntry[] {
  const available = new Set(files);
  const explicit = new Map(EXPLICIT_PURE_TARGETS.map((target) => [target.path, target]));
  const discovered = new Map<string, PureTargetEntry>();
  for (const path of available) {
    const reviewed = explicit.get(path);
    if (reviewed)
      discovered.set(path, entry(path, reviewed.target_kind, "explicit_manifest", readText(path)));
    else if (path.startsWith("apps/engine/src/") && isCorePath(path))
      discovered.set(path, entry(path, "engine_core", "isCorePath", readText(path)));
  }
  return [...discovered.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export function validatePureTargetInventory(
  files: readonly string[],
  readText: (path: string) => string | null = defaultReadText,
): string[] {
  const available = new Set(files);
  const errors = [
    ...EXPLICIT_PURE_TARGETS.map((target) => target.path),
    ...REVIEWED_ENGINE_CORE_TARGET_PATHS,
  ]
    .filter((path) => !available.has(path))
    .map((path) => `reviewed pure target is missing from inventory: ${path}`);
  const discovered = discoverPureTargets(files, readText);
  const paths = new Set<string>();
  for (const target of discovered) {
    if (paths.has(target.path)) errors.push(`duplicate canonical pure target: ${target.path}`);
    paths.add(target.path);
  }
  return errors;
}

export function assertCompletePureTargetInventory(
  files: readonly string[],
  readText: (path: string) => string | null = defaultReadText,
): PureTargetEntry[] {
  const errors = validatePureTargetInventory(files, readText);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return discoverPureTargets(files, readText);
}

export function pureTargetPaths(files: readonly string[]): string[] {
  return discoverPureTargets(files).map((target) => target.path);
}

export function runtimePureTargetPaths(entries: readonly PureTargetEntry[]): string[] {
  return entries.filter((target) => target.runtime_kind === "runtime").map((target) => target.path);
}

export function pureTargetDigest(entries: readonly PureTargetEntry[]): string {
  const seen = new Set<string>();
  const canonical = [...entries]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((target) => {
      if (seen.has(target.path)) throw new Error(`duplicate canonical pure target: ${target.path}`);
      seen.add(target.path);
      return {
        path: target.path,
        owner_shard: target.owner_shard,
        subsystem: target.subsystem,
        target_kind: target.target_kind,
        eligibility: target.eligibility,
        source_of_inclusion: target.source_of_inclusion,
        public_facade_obligations: [...target.public_facade_obligations].sort(),
        effect_ledger_status: target.effect_ledger_status,
        runtime_kind: target.runtime_kind,
      };
    });
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export const canonicalPureTargetDigest = pureTargetDigest;

export const reviewedExplicitPureTargetPaths = (): readonly string[] => EXPLICIT_PURE_TARGET_PATHS;
