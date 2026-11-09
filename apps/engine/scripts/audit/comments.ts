import ts from "typescript";

const DIRECTIVE =
  /biome-ignore|@ts-expect-error|@ts-ignore|@ts-nocheck|@ts-check|eslint-disable|tenant-filter:exempt|-allowed:|allow-wall-clock|allow-random|@__PURE__|#__PURE__|@jsxImportSource|^\/\/\/\s*<reference|@vite-ignore|prettier-ignore/;
const STRYKER_DIRECTIVE =
  /^(?:\/\/|\/\*)\s*Stryker (?:disable|restore)(?: next-line)? (?:all|[A-Za-z]+(?:,\s*[A-Za-z]+)*)(?::[^\r\n]*)?(?:\s*\*\/)?$/;

export const COMMENT_SCOPE = /^(apps|packages|scripts|tests)\/.*\.(ts|tsx|mjs|js)$/;

export const COMMENT_EXEMPT =
  /(^|\/)(node_modules|dist)\/|apps\/engine\/src\/db\/migrations\/embedded\.ts$|cockpit-embedded\.ts$|apps\/cockpit\/src\/api\/schema\.d\.ts$|packages\/cli-core\/src\/engine-api\/openapi\.d\.ts$/;

interface CommentHit {
  line: number;
  text: string;
  pos: number;
  end: number;
}

export function findComments(file: string, text: string): CommentHit[] {
  const kind =
    file.endsWith(".tsx") || file.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const jsxText: Array<[number, number]> = [];
  const collect = (node: ts.Node) => {
    if (node.kind === ts.SyntaxKind.JsxText) jsxText.push([node.pos, node.end]);
    ts.forEachChild(node, collect);
  };
  collect(sf);
  const insideJsxText = (pos: number) => jsxText.some(([start, end]) => pos >= start && pos < end);
  const hits = new Map<number, CommentHit>();
  const kept = new Set<number>();
  const visit = (pos: number) => {
    if (insideJsxText(pos)) return;
    for (const ranges of [
      ts.getLeadingCommentRanges(text, pos),
      ts.getTrailingCommentRanges(text, pos),
    ]) {
      let run = false;
      let prevEnd = -1;
      for (const r of ranges ?? []) {
        const body = text.slice(r.pos, r.end);
        const adjacent = prevEnd >= 0 && /^[ \t]*\r?\n[ \t]*$/.test(text.slice(prevEnd, r.pos));
        prevEnd = r.end;
        if (
          DIRECTIVE.test(body) ||
          STRYKER_DIRECTIVE.test(body) ||
          (r.pos === 0 && body.startsWith("#!"))
        ) {
          run = true;
          kept.add(r.pos);
          continue;
        }
        if (run && adjacent && body.startsWith("//")) {
          kept.add(r.pos);
          continue;
        }
        run = false;
        if (kept.has(r.pos) || hits.has(r.pos)) continue;
        hits.set(r.pos, {
          line: sf.getLineAndCharacterOfPosition(r.pos).line + 1,
          text: body.split("\n")[0] ?? "",
          pos: r.pos,
          end: r.end,
        });
      }
    }
  };
  const walk = (node: ts.Node) => {
    if (node.kind === ts.SyntaxKind.JsxText) return;
    visit(node.getFullStart());
    for (const child of node.getChildren(sf)) walk(child);
  };
  walk(sf);
  for (const pos of kept) hits.delete(pos);
  return [...hits.values()];
}
