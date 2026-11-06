import { dirname, join, normalize } from "node:path/posix";
import ts from "typescript";

export interface ImportRef {
  specifier: string;
  typeOnly: boolean;
  line: number;
}

function scriptKind(file: string): ts.ScriptKind {
  return file.endsWith(".tsx") || file.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

export function parseSource(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function importClauseIsTypeOnly(clause: ts.ImportClause | undefined): boolean {
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  if (clause.name) return false;
  const bindings = clause.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings)) return false;
  return bindings.elements.length > 0 && bindings.elements.every((el) => el.isTypeOnly);
}

export function collectImportsFromSource(sf: ts.SourceFile): ImportRef[] {
  const out: ImportRef[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      out.push({
        specifier: node.moduleSpecifier.text,
        typeOnly: importClauseIsTypeOnly(node.importClause),
        line: lineOf(sf, node),
      });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      out.push({
        specifier: node.moduleSpecifier.text,
        typeOnly: node.isTypeOnly,
        line: lineOf(sf, node),
      });
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      out.push({
        specifier: node.moduleReference.expression.text,
        typeOnly: node.isTypeOnly,
        line: lineOf(sf, node),
      });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      out.push({ specifier: node.arguments[0].text, typeOnly: false, line: lineOf(sf, node) });
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      out.push({ specifier: node.argument.literal.text, typeOnly: true, line: lineOf(sf, node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

export function collectImports(file: string, text: string): ImportRef[] {
  return collectImportsFromSource(parseSource(file, text));
}

const RESOLVED_EXTENSION = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json)$/;

export function resolveImport(
  fromFile: string,
  specifier: string,
  exists: (repoPath: string) => boolean,
): string {
  if (!specifier.startsWith(".")) return specifier;
  return resolveRepoPath(normalize(join(dirname(fromFile), specifier)), exists);
}

export function resolveRepoPath(base: string, exists: (repoPath: string) => boolean): string {
  if (RESOLVED_EXTENSION.test(base)) {
    if (base.endsWith(".js")) {
      const asTs = base.replace(/\.js$/, ".ts");
      if (exists(asTs)) return asTs;
    }
    return base;
  }
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (exists(candidate)) return candidate;
  }
  return base;
}
