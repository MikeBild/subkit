import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const RUNNER = import.meta.dir;

function handled(call: ts.Expression): boolean {
  let node = call;
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  const name = node.expression.name.text;
  return name === "catch" || (name === "then" && node.arguments.length === 2);
}

function floatingVoids(path: string, source: string): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const hits: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVoidExpression(node) && !handled(node.expression)) {
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      hits.push(`${path}:${line}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return hits;
}

function runnerSources(directory = RUNNER): { path: string; source: string }[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return runnerSources(path);
    if (!/\.ts$/.test(entry.name) || /\.(test|fixture)\.ts$/.test(entry.name)) return [];
    return [{ path: relative(RUNNER, path), source: readFileSync(path, "utf8") }];
  });
}

describe("promises in the runner", () => {
  test("no promise is discarded with void unless its failure has a receiver", () => {
    expect(runnerSources().flatMap(({ path, source }) => floatingVoids(path, source))).toEqual([]);
  });

  test("the rule catches a discarded promise and accepts a handled one", () => {
    expect(floatingVoids("x.ts", "void claim(id);")).toEqual(["x.ts:1"]);
    expect(floatingVoids("x.ts", "void close().finally(exit);")).toEqual(["x.ts:1"]);
    expect(floatingVoids("x.ts", "void claim(id).then(run);")).toEqual(["x.ts:1"]);
    expect(floatingVoids("x.ts", "void claim(id).catch(report);")).toEqual([]);
    expect(floatingVoids("x.ts", "void (claim(id).then(run, report));")).toEqual([]);
  });
});
