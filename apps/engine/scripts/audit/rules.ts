import ts from "typescript";
import type { ImportRef } from "./imports.ts";

export const ENGINE_SRC_PREFIX = "apps/engine/src/";

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

function subsystemOf(path: string): string | null {
  if (!path.startsWith(ENGINE_SRC_PREFIX)) return null;
  const rest = path.slice(ENGINE_SRC_PREFIX.length);
  const slash = rest.indexOf("/");
  return slash === -1 ? rest : rest.slice(0, slash);
}

export function pureCoreImportHits(imports: readonly ResolvedImport[]): RuleHit[] {
  const hits: RuleHit[] = [];
  for (const imp of imports) {
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
      else if (prop === "randomUUID") push(node, "randomUUID");
    } else if (
      ts.isNewExpression(node) &&
      isNamed(node.expression, "Date") &&
      (node.arguments?.length ?? 0) === 0
    ) {
      push(node, "new Date()");
    } else if (ts.isCallExpression(node) && isNamed(node.expression, "randomUUID")) {
      push(node, "randomUUID");
    } else if (
      ts.isImportSpecifier(node) &&
      (node.propertyName ?? node.name).text === "randomUUID"
    ) {
      push(node, "randomUUID");
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
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

export const CONVERSATIONS_PREFIX = `${ENGINE_SRC_PREFIX}conversations/`;

export const CONVERSATIONS_ENTRY_POINTS: ReadonlySet<string> = new Set([
  `${CONVERSATIONS_PREFIX}tools/index.ts`,
  `${CONVERSATIONS_PREFIX}types.ts`,
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
