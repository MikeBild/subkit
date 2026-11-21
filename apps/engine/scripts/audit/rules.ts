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
  `${CONVERSATIONS_PREFIX}public/scheduled.ts`,
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

export function engineFolderOf(path: string): string | null {
  if (!path.startsWith(ENGINE_SRC_PREFIX)) return null;
  const rest = path.slice(ENGINE_SRC_PREFIX.length);
  const slash = rest.indexOf("/");
  return slash > 0 ? rest.slice(0, slash) : null;
}

export function subsystemEntryHits(file: string, imports: readonly ResolvedImport[]): RuleHit[] {
  const from = engineFolderOf(file);
  return imports
    .filter((imp) => {
      const to = engineFolderOf(imp.resolved);
      return to !== null && to !== from && imp.resolved !== `${ENGINE_SRC_PREFIX}${to}/index.ts`;
    })
    .map((imp) => ({ line: imp.line, what: imp.resolved }));
}

interface VendorSdk {
  name: string;
  matches(specifier: string): boolean;
  adapter(rest: string): boolean;
}

const inAdapterFolder = (rest: string) =>
  rest.startsWith("adapters/") || rest.includes("/adapters/");
const inPersistence = (rest: string) =>
  rest.startsWith("db/") || rest.includes("/persistence/") || inAdapterFolder(rest);

export const VENDOR_SDKS: readonly VendorSdk[] = [
  {
    name: "drizzle-orm",
    matches: (s) => s === "drizzle-orm" || s.startsWith("drizzle-orm/"),
    adapter: inPersistence,
  },
  {
    name: "pg",
    matches: (s) => s === "pg",
    adapter: (rest) =>
      inPersistence(rest) || rest.startsWith("connectors/drivers/") || rest.startsWith("pubsub/"),
  },
  {
    name: "pg-boss",
    matches: (s) => s === "pg-boss",
    adapter: (rest) => rest === "queue/boss.ts" || inAdapterFolder(rest),
  },
  {
    name: "@modelcontextprotocol/sdk",
    matches: (s) => s === "@modelcontextprotocol/sdk" || s.startsWith("@modelcontextprotocol/sdk/"),
    adapter: (rest) =>
      rest.startsWith("mcp/client/") ||
      rest.startsWith("mcp/transports/") ||
      rest === "mcp/server.ts" ||
      inAdapterFolder(rest),
  },
  {
    name: "ai",
    matches: (s) => s === "ai" || s.startsWith("ai/") || s.startsWith("@ai-sdk/"),
    adapter: (rest) => rest.startsWith("llm/runtime/") || inAdapterFolder(rest),
  },
];

export function vendorImportHits(file: string, imports: readonly ResolvedImport[]): RuleHit[] {
  if (!file.startsWith(ENGINE_SRC_PREFIX) || isTestPath(file)) return [];
  const rest = file.slice(ENGINE_SRC_PREFIX.length);
  const hits: RuleHit[] = [];
  for (const imp of imports) {
    if (imp.typeOnly) continue;
    const sdk = VENDOR_SDKS.find((candidate) => candidate.matches(imp.specifier));
    if (sdk && !sdk.adapter(rest)) hits.push({ line: imp.line, what: imp.specifier });
  }
  return hits;
}

function lineAt(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

export const COMPOSITION_ROOTS: ReadonlySet<string> = new Set([
  `${ENGINE_SRC_PREFIX}db/client.ts`,
  `${ENGINE_SRC_PREFIX}engine-main.ts`,
  `${ENGINE_SRC_PREFIX}preflight/cli-entry.ts`,
  `${ENGINE_SRC_PREFIX}db/print-key.ts`,
  `${ENGINE_SRC_PREFIX}auth/oauth/token-exchange-cli.ts`,
]);

export function getDbCallHits(sf: ts.SourceFile): RuleHit[] {
  const hits: RuleHit[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && isNamed(node.expression, "getDb")) {
      hits.push({ line: lineAt(sf, node), what: "getDb()" });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

export const ENV_SEAMS: ReadonlySet<string> = new Set([
  `${ENGINE_SRC_PREFIX}env.ts`,
  `${ENGINE_SRC_PREFIX}test-helpers/determinism/env.ts`,
]);

export function processEnvHits(file: string, sf: ts.SourceFile): RuleHit[] {
  if (ENV_SEAMS.has(file)) return [];
  const hits: RuleHit[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      isNamed(node.expression, "process") &&
      propertyName(node) === "env"
    ) {
      hits.push({ line: lineAt(sf, node), what: "process.env" });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

const LINT_SUPPRESSION = /^(?:\/\/|\/\*)\s*biome-ignore/;

export function lintSuppressionHits(sf: ts.SourceFile): RuleHit[] {
  const text = sf.getFullText();
  const seen = new Map<number, RuleHit>();
  const collect = (ranges: ts.CommentRange[] | undefined) => {
    for (const r of ranges ?? []) {
      if (seen.has(r.pos) || !LINT_SUPPRESSION.test(text.slice(r.pos, r.end))) continue;
      seen.set(r.pos, {
        line: sf.getLineAndCharacterOfPosition(r.pos).line + 1,
        what: "biome-ignore",
      });
    }
  };
  const walk = (node: ts.Node) => {
    if (node.kind === ts.SyntaxKind.JsxText) return;
    collect(ts.getLeadingCommentRanges(text, node.getFullStart()));
    collect(ts.getTrailingCommentRanges(text, node.getEnd()));
    for (const child of node.getChildren(sf)) walk(child);
  };
  walk(sf);
  return [...seen.values()].sort((a, b) => a.line - b.line);
}
