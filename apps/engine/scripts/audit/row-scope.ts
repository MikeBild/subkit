import ts from "typescript";
import { ROW_SCOPED_TABLES } from "../../src/db/core/tenant-scope.ts";

export const ROW_SCOPE_CALLS = new Set(["withRowScope", "withTenantScope", "withSystemScope"]);
export const SCOPED_TX_TYPE = "ScopedTx";
const ALLOW_DIRECTIVE = /row-scope-allowed:\s*\S/;

const camel = (table: string) => table.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());

export const ROW_SCOPED_EXPORTS: ReadonlyMap<string, string> = new Map(
  ROW_SCOPED_TABLES.map((table) => [camel(table), table]),
);

const RAW_TABLE = new RegExp(`\\b(${ROW_SCOPED_TABLES.join("|")})\\b`);
const RAW_SQL = /\b(select|insert|update|delete|from|join|into|table|truncate)\b/i;
const SQL_CALLS = new Set(["raw", "query", "execute"]);

export interface RowScopeHit {
  line: number;
  table: string;
  how: "table" | "raw_sql";
}

export function isRowScopeScope(rel: string): boolean {
  return (
    rel.startsWith("apps/engine/src/") &&
    !rel.startsWith("apps/engine/src/db/schema/") &&
    !rel.startsWith("apps/engine/src/db/migrations/") &&
    rel !== "apps/engine/src/db/schema.ts"
  );
}

function isSchemaModule(resolved: string): boolean {
  return (
    resolved === "apps/engine/src/db/index.ts" ||
    resolved === "apps/engine/src/db/schema.ts" ||
    resolved.startsWith("apps/engine/src/db/schema/")
  );
}

interface Bindings {
  named: Map<string, string>;
  namespaces: Set<string>;
}

function collectBindings(sf: ts.SourceFile, resolve: (specifier: string) => string): Bindings {
  const named = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    if (!isSchemaModule(resolve(statement.moduleSpecifier.text))) continue;
    const bindings = clause.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      continue;
    }
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      const exported = (element.propertyName ?? element.name).text;
      const table = ROW_SCOPED_EXPORTS.get(exported);
      if (table) named.set(element.name.text, table);
    }
  }
  return { named, namespaces };
}

function hasAllowDirective(sf: ts.SourceFile, node: ts.Node): boolean {
  const text = sf.getFullText();
  const ranges = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [];
  return ranges.some((r) => ALLOW_DIRECTIVE.test(text.slice(r.pos, r.end)));
}

function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

function isScopeCallback(fn: ts.SignatureDeclaration): boolean {
  const parent = fn.parent;
  return (
    parent !== undefined &&
    ts.isCallExpression(parent) &&
    parent.arguments.some((arg) => arg === fn) &&
    ROW_SCOPE_CALLS.has(calleeName(parent) ?? "")
  );
}

function takesScopedTx(fn: ts.SignatureDeclaration, sf: ts.SourceFile): boolean {
  return fn.parameters.some((p) => p.type?.getText(sf).includes(SCOPED_TX_TYPE) === true);
}

function inTypePosition(node: ts.Node): boolean {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (ts.isTypeNode(cur)) return true;
    if (ts.isStatement(cur) || ts.isFunctionLike(cur)) return false;
  }
  return false;
}

function isScoped(node: ts.Node, sf: ts.SourceFile): boolean {
  for (let cur: ts.Node | undefined = node; cur; cur = cur.parent) {
    if (ts.isFunctionLike(cur)) {
      if (isScopeCallback(cur) || takesScopedTx(cur, sf)) return true;
    }
    if ((ts.isStatement(cur) || ts.isFunctionLike(cur)) && hasAllowDirective(sf, cur)) return true;
  }
  return false;
}

function tableReference(node: ts.Node, bindings: Bindings): string | null {
  if (ts.isIdentifier(node)) {
    const parent = node.parent;
    if (
      parent &&
      (ts.isImportSpecifier(parent) ||
        ts.isExportSpecifier(parent) ||
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node))
    )
      return null;
    return bindings.named.get(node.text) ?? null;
  }
  if (ts.isPropertyAccessExpression(node)) {
    const table = ROW_SCOPED_EXPORTS.get(node.name.text);
    if (!table) return null;
    const target = node.expression;
    if (ts.isIdentifier(target) && bindings.namespaces.has(target.text)) return table;
    if (ts.isPropertyAccessExpression(target) && target.name.text === "query") return table;
  }
  return null;
}

const ACCESS_CALLS = new Set([
  "from",
  "insert",
  "update",
  "delete",
  "join",
  "innerJoin",
  "leftJoin",
  "rightJoin",
  "fullJoin",
  "crossJoin",
]);

function isAccessPosition(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node)) return true;
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isTemplateSpan(parent)) return true;
  return (
    ts.isCallExpression(parent) &&
    parent.arguments[0] === node &&
    ts.isPropertyAccessExpression(parent.expression) &&
    ACCESS_CALLS.has(parent.expression.name.text)
  );
}

function isSqlContext(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isTaggedTemplateExpression(parent)) {
    const tag = parent.tag;
    return (
      (ts.isIdentifier(tag) && tag.text === "sql") ||
      (ts.isPropertyAccessExpression(tag) && tag.name.text === "sql")
    );
  }
  if (ts.isCallExpression(parent)) return SQL_CALLS.has(calleeName(parent) ?? "");
  if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name))
    return parent.name.text === "text" || /sql/i.test(parent.name.text);
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name))
    return /sql/i.test(parent.name.text);
  return false;
}

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node))
    return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(" ");
  return null;
}

export function rowScopeHits(
  sf: ts.SourceFile,
  resolve: (specifier: string) => string,
): RowScopeHit[] {
  const bindings = collectBindings(sf, resolve);
  const hits: RowScopeHit[] = [];
  const line = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    const table = tableReference(node, bindings);
    if (table && isAccessPosition(node) && !inTypePosition(node) && !isScoped(node, sf)) {
      hits.push({ line: line(node), table, how: "table" });
    }
    const text = literalText(node);
    if (text !== null) {
      const raw = RAW_TABLE.exec(text);
      if (raw?.[1] && RAW_SQL.test(text) && isSqlContext(node) && !isScoped(node, sf))
        hits.push({ line: line(node), table: raw[1], how: "raw_sql" });
      if (ts.isTemplateExpression(node)) {
        for (const span of node.templateSpans) visit(span.expression);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}
