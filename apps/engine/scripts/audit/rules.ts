import ts from "typescript";
import type { ImportRef } from "./imports.ts";

const ENGINE_SRC_PREFIX = "apps/engine/src/";

export interface ResolvedImport extends ImportRef {
  resolved: string;
}

export interface RuleHit {
  line: number;
  what: string;
}

export function isTestPath(path: string): boolean {
  return (
    /\.test\.tsx?$/.test(path) ||
    /-fixtures\.tsx?$/.test(path) ||
    path.includes("/tests/") ||
    path.includes("/__tests__/") ||
    path.includes("/test-helpers/")
  );
}

export function isCorePath(path: string): boolean {
  if (isTestPath(path) || !/\.tsx?$/.test(path) || path.endsWith(".d.ts")) return false;
  return /(^|\/)core\.tsx?$/.test(path) || path.includes("/core/");
}

export function lineCount(text: string): number {
  return text.split("\n").length;
}

function isDbSchemaTarget(resolved: string): boolean {
  return (
    resolved === `${ENGINE_SRC_PREFIX}db/schema.ts` ||
    resolved.startsWith(`${ENGINE_SRC_PREFIX}db/schema/`)
  );
}

export function dbImportHits(imports: readonly ResolvedImport[]): RuleHit[] {
  return imports
    .filter(
      (imp) =>
        !imp.typeOnly &&
        (imp.specifier === "drizzle-orm" ||
          imp.specifier.startsWith("drizzle-orm/") ||
          isDbSchemaTarget(imp.resolved)),
    )
    .map((imp) => ({ line: imp.line, what: imp.specifier }));
}

const IMPURE_SUBSYSTEMS = ["db", "llm", "audit", "queue"] as const;
const EFFECT_MODULES = new Set([
  "fs",
  "fs/promises",
  "node:fs",
  "node:fs/promises",
  "http",
  "https",
  "node:http",
  "node:https",
  "net",
  "node:net",
  "tls",
  "node:tls",
  "child_process",
  "node:child_process",
  "readline",
  "node:readline",
]);

function subsystemOf(path: string): string | null {
  if (!path.startsWith(ENGINE_SRC_PREFIX)) return null;
  const rest = path.slice(ENGINE_SRC_PREFIX.length);
  const slash = rest.indexOf("/");
  return slash === -1 ? rest : rest.slice(0, slash);
}

export function pureCoreImportHits(imports: readonly ResolvedImport[]): RuleHit[] {
  const hits: RuleHit[] = [];
  for (const imp of imports) {
    if (EFFECT_MODULES.has(imp.specifier)) {
      hits.push({ line: imp.line, what: `import ${imp.specifier}` });
      continue;
    }
    if (imp.specifier === "drizzle-orm" || imp.specifier.startsWith("drizzle-orm/")) {
      hits.push({ line: imp.line, what: `import ${imp.specifier}` });
      continue;
    }
    const target = subsystemOf(imp.resolved);
    if (target === null) continue;
    if ((IMPURE_SUBSYSTEMS as readonly string[]).includes(target)) {
      hits.push({ line: imp.line, what: `import ${imp.specifier}` });
    }
  }
  return hits;
}

function isNamed(node: ts.Expression, name: string): boolean {
  return ts.isIdentifier(node) && node.text === name;
}

function propertyName(node: ts.PropertyAccessExpression): string {
  return node.name.text;
}

export function effectHits(sf: ts.SourceFile): RuleHit[] {
  const hits: RuleHit[] = [];
  const push = (node: ts.Node, what: string) =>
    hits.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, what });
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node)) {
      const prop = propertyName(node);
      if (isNamed(node.expression, "Date") && prop === "now") push(node, "Date.now");
      else if (isNamed(node.expression, "Math") && prop === "random") push(node, "Math.random");
      else if (isNamed(node.expression, "process") && prop === "env") push(node, "process.env");
      else if (
        (isNamed(node.expression, "crypto") &&
          ["randomUUID", "randomBytes", "randomFill", "randomFillSync", "randomInt"].includes(
            prop,
          )) ||
        prop === "randomUUID"
      )
        push(node, prop);
      else if (
        isNamed(node.expression, "process") &&
        ["stdout", "stderr", "exit", "exitCode"].includes(prop)
      )
        push(node, `process.${prop}`);
    } else if (
      ts.isNewExpression(node) &&
      isNamed(node.expression, "Date") &&
      (node.arguments?.length ?? 0) === 0
    ) {
      push(node, "new Date()");
    } else if (ts.isCallExpression(node)) {
      if (isNamed(node.expression, "randomUUID")) push(node, "randomUUID");
      else if (isNamed(node.expression, "fetch")) push(node, "fetch");
      else if (isNamed(node.expression, "require")) push(node, "require");
      else if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        (!node.arguments[0] || !ts.isStringLiteralLike(node.arguments[0]))
      )
        push(node, "computed dynamic import");
    } else if (
      ts.isImportSpecifier(node) &&
      ["randomUUID", "randomBytes", "randomFill", "randomFillSync", "randomInt"].includes(
        (node.propertyName ?? node.name).text,
      )
    ) {
      push(node, (node.propertyName ?? node.name).text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

const GETDB_FALLBACK_FILES: ReadonlySet<string> = new Set([
  `${ENGINE_SRC_PREFIX}connectors/egress-guard.ts`,
  `${ENGINE_SRC_PREFIX}engine-client/index.ts`,
]);

export function isGetDbFallbackScope(path: string): boolean {
  if (!path.startsWith(ENGINE_SRC_PREFIX) || isTestPath(path)) return false;
  return path.endsWith("/service.ts") || GETDB_FALLBACK_FILES.has(path);
}

export function getDbFallbackHits(sf: ts.SourceFile): RuleHit[] {
  const hits: RuleHit[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
      let right: ts.Expression = node.right;
      while (ts.isParenthesizedExpression(right)) right = right.expression;
      if (
        ts.isCallExpression(right) &&
        isNamed(right.expression, "getDb") &&
        right.arguments.length === 0
      ) {
        hits.push({
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          what: "?? getDb()",
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

const CONVERSATIONS_PREFIX = `${ENGINE_SRC_PREFIX}conversations/`;

const CONVERSATIONS_ENTRY_POINTS: ReadonlySet<string> = new Set([
  `${CONVERSATIONS_PREFIX}tools/index.ts`,
  `${CONVERSATIONS_PREFIX}types.ts`,
  `${CONVERSATIONS_PREFIX}public/lifecycle.ts`,
  `${CONVERSATIONS_PREFIX}public/authoring.ts`,
  `${CONVERSATIONS_PREFIX}public/context.ts`,
  `${CONVERSATIONS_PREFIX}public/elicitation.ts`,
  `${CONVERSATIONS_PREFIX}public/policy.ts`,
  `${CONVERSATIONS_PREFIX}public/tool-contract.ts`,
]);

export function conversationsLeafHits(file: string, imports: readonly ResolvedImport[]): RuleHit[] {
  if (file.startsWith(CONVERSATIONS_PREFIX)) return [];
  return imports
    .filter(
      (imp) =>
        imp.resolved.startsWith(CONVERSATIONS_PREFIX) &&
        !CONVERSATIONS_ENTRY_POINTS.has(imp.resolved),
    )
    .map((imp) => ({ line: imp.line, what: imp.resolved }));
}
