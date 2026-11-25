import ts from "typescript";
import type { RuleHit } from "./rules.ts";

const lineOf = (sf: ts.SourceFile, node: ts.Node) =>
  sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

function walk(sf: ts.SourceFile, visit: (node: ts.Node) => void): void {
  const step = (node: ts.Node) => {
    visit(node);
    ts.forEachChild(node, step);
  };
  step(sf);
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  )
    current = current.expression;
  return current;
}

function methodCall(node: ts.Node, name: string): ts.CallExpression | null {
  if (!ts.isCallExpression(node)) return null;
  const callee = node.expression;
  return ts.isPropertyAccessExpression(callee) && callee.name.text === name ? node : null;
}

function updatedTable(set: ts.CallExpression): string | null {
  const callee = set.expression;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  const update = methodCall(unwrap(callee.expression), "update");
  const target = update?.arguments[0];
  return target && ts.isIdentifier(target) ? target.text : null;
}

function writesColumn(arg: ts.Expression | undefined, column: string): boolean {
  if (!arg) return false;
  const value = unwrap(arg);
  if (ts.isConditionalExpression(value))
    return writesColumn(value.whenTrue, column) || writesColumn(value.whenFalse, column);
  if (!ts.isObjectLiteralExpression(value)) return false;
  return value.properties.some((prop) =>
    ts.isSpreadAssignment(prop)
      ? writesColumn(prop.expression, column)
      : (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) &&
        (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) &&
        prop.name.text === column,
  );
}

export function statusWriteHits(
  sf: ts.SourceFile,
  columns: ReadonlyMap<string, string>,
): RuleHit[] {
  const hits: RuleHit[] = [];
  walk(sf, (node) => {
    const set = methodCall(node, "set");
    if (!set) return;
    const table = updatedTable(set);
    const column = table ? columns.get(table) : undefined;
    if (column && writesColumn(set.arguments[0], column))
      hits.push({ line: lineOf(sf, set), what: `${table}.${column}` });
  });
  return hits;
}

function isEmptyFunction(node: ts.Expression): boolean {
  const fn = unwrap(node);
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false;
  const body = fn.body;
  if (ts.isBlock(body)) return body.statements.length === 0;
  const value = unwrap(body);
  return (
    (ts.isIdentifier(value) && value.text === "undefined") ||
    value.kind === ts.SyntaxKind.NullKeyword ||
    ts.isVoidExpression(value)
  );
}

export function emptyCatchHits(sf: ts.SourceFile): RuleHit[] {
  const hits: RuleHit[] = [];
  walk(sf, (node) => {
    if (ts.isCatchClause(node) && node.block.statements.length === 0) {
      hits.push({ line: lineOf(sf, node), what: "catch {}" });
      return;
    }
    const call = methodCall(node, "catch");
    const handler = call?.arguments[0];
    if (call && handler && isEmptyFunction(handler))
      hits.push({ line: lineOf(sf, call), what: ".catch(() => {})" });
  });
  return hits;
}

export function thenWithAwaitHits(sf: ts.SourceFile): RuleHit[] {
  const thens: RuleHit[] = [];
  let awaits = false;
  walk(sf, (node) => {
    if (ts.isAwaitExpression(node)) awaits = true;
    else if (methodCall(node, "then")) thens.push({ line: lineOf(sf, node), what: ".then(" });
  });
  return awaits ? thens : [];
}

const BACKOFF_NAME = /(?:^|[a-z])(?:[Bb]ackoff|[Rr]etryAfter)\w*$/;

interface FunctionDecl {
  name: string;
  line: number;
  body: ts.Node;
}

function declaredFunctions(sf: ts.SourceFile): FunctionDecl[] {
  const out: FunctionDecl[] = [];
  walk(sf, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      out.push({ name: node.name.text, line: lineOf(sf, node), body: node.body });
      return;
    }
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) return;
    const fn = unwrap(node.initializer);
    if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))
      out.push({ name: node.name.text, line: lineOf(sf, node), body: fn.body });
  });
  return out;
}

function contains(root: ts.Node, match: (node: ts.Node) => boolean): boolean {
  let found = false;
  const step = (node: ts.Node) => {
    if (found) return;
    if (match(node)) found = true;
    else ts.forEachChild(node, step);
  };
  step(root);
  return found;
}

function isJsonStringify(node: ts.Node): boolean {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  const { expression, name } = node.expression;
  return ts.isIdentifier(expression) && expression.text === "JSON" && name.text === "stringify";
}

function isSha256Hash(node: ts.Node): boolean {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return false;
  const [algorithm] = node.arguments;
  return (
    node.expression.text === "createHash" &&
    algorithm !== undefined &&
    ts.isStringLiteralLike(algorithm) &&
    algorithm.text === "sha256"
  );
}

function isKeySort(node: ts.Node): boolean {
  const sort = methodCall(node, "sort");
  if (!sort || !ts.isPropertyAccessExpression(sort.expression)) return false;
  const receiver = unwrap(sort.expression.expression);
  if (!ts.isCallExpression(receiver) || !ts.isPropertyAccessExpression(receiver.expression))
    return false;
  const { expression, name } = receiver.expression;
  return (
    ts.isIdentifier(expression) &&
    expression.text === "Object" &&
    (name.text === "keys" || name.text === "entries")
  );
}

const SHA256_HELPER_NAME = /sha256/i;
const CANONICAL_JSON_MAX_STATEMENTS = 8;

function statementCount(body: ts.Node): number {
  return ts.isBlock(body) ? body.statements.length : 1;
}

export function canonicalHashHelperHits(sf: ts.SourceFile): RuleHit[] {
  const hits: RuleHit[] = [];
  for (const fn of declaredFunctions(sf)) {
    if (
      statementCount(fn.body) <= CANONICAL_JSON_MAX_STATEMENTS &&
      contains(fn.body, isJsonStringify) &&
      contains(fn.body, isKeySort)
    )
      hits.push({ line: fn.line, what: `canonical JSON ${fn.name}` });
    else if (SHA256_HELPER_NAME.test(fn.name) && contains(fn.body, isSha256Hash))
      hits.push({ line: fn.line, what: `sha256 ${fn.name}` });
  }
  return hits;
}

export function backoffHelperHits(sf: ts.SourceFile): RuleHit[] {
  return declaredFunctions(sf)
    .filter((fn) => BACKOFF_NAME.test(fn.name))
    .map((fn) => ({ line: fn.line, what: `backoff ${fn.name}` }));
}

const ENGINE = "apps/engine/src/";

export const STATUS_WRITERS: ReadonlyMap<string, { column: string; writer: string | null }> =
  new Map([
    ["executions", { column: "status", writer: `${ENGINE}execution/state.ts` }],
    [
      "patchCandidates",
      { column: "status", writer: `${ENGINE}self-healing/persistence/patch-candidate-status.ts` },
    ],
    [
      "intakeProposals",
      { column: "status", writer: `${ENGINE}knowledge/persistence/intake-status.ts` },
    ],
    ["intakeItems", { column: "state", writer: `${ENGINE}knowledge/persistence/intake-status.ts` }],
    [
      "conversationElicitations",
      { column: "status", writer: `${ENGINE}conversations/elicitations.ts` },
    ],
    [
      "conversations",
      { column: "status", writer: `${ENGINE}conversations/persistence/conversation-status.ts` },
    ],
  ]);

const STATUS_COLUMNS: ReadonlyMap<string, string> = new Map(
  [...STATUS_WRITERS].map(([table, { column }]) => [table, column]),
);

export function statusWriterHits(file: string, sf: ts.SourceFile): RuleHit[] {
  return statusWriteHits(sf, STATUS_COLUMNS).filter((hit) => {
    const table = hit.what.slice(0, hit.what.indexOf("."));
    return STATUS_WRITERS.get(table)?.writer !== file;
  });
}

export function isApiInternalImport(resolved: string): boolean {
  return resolved.startsWith(`${ENGINE}api/`) && resolved !== `${ENGINE}api/index.ts`;
}

export function httpErrorThrowHits(sf: ts.SourceFile): RuleHit[] {
  const hits: RuleHit[] = [];
  walk(sf, (node) => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "HttpError"
    )
      hits.push({ line: lineOf(sf, node), what: "new HttpError" });
  });
  return hits;
}
