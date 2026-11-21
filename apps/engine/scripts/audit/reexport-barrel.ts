import ts from "typescript";

export const REEXPORT_BARREL_EXCLUSION =
  "AST-verified re-export barrel: every statement is an export declaration with a module specifier.";

function isReexport(statement: ts.Statement): boolean {
  return ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined;
}

export function isReexportBarrel(path: string, source: string): boolean {
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    false,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  return file.statements.length > 0 && file.statements.every(isReexport);
}

export function reexportBarrelExclusion(path: string, source: string | null): string | undefined {
  return source !== null && isReexportBarrel(path, source) ? REEXPORT_BARREL_EXCLUSION : undefined;
}
