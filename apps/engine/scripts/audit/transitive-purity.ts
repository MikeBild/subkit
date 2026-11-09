import type { AliasScope } from "./import-graph.ts";
import { resolveSpecifier } from "./import-graph.ts";
import { collectImportsFromSource, parseSource } from "./imports.ts";
import { effectHits, pureCoreImportHits } from "./rules.ts";

export interface TransitivePurityHit {
  target: string;
  chain: readonly string[];
  line: number;
  what: string;
}

export function findTransitivePurityHits(input: {
  target: string;
  files: readonly string[];
  readText: (path: string) => string | null;
  scopes: readonly AliasScope[];
}): TransitivePurityHit[] {
  const known = new Set(input.files);
  const visited = new Set<string>();
  const hits: TransitivePurityHit[] = [];
  const exists = (path: string) => known.has(path);
  const visit = (path: string, chain: readonly string[]) => {
    if (visited.has(path)) return;
    visited.add(path);
    const source = input.readText(path);
    if (source === null) return;
    const tree = parseSource(path, source);
    const imports = collectImportsFromSource(tree).map((ref) => ({
      ...ref,
      resolved: resolveSpecifier(path, ref.specifier, input.scopes, exists),
    }));
    for (const hit of [
      ...pureCoreImportHits(imports.filter((ref) => !ref.typeOnly)),
      ...effectHits(tree),
    ])
      hits.push({ target: input.target, chain: [...chain, path], ...hit });
    for (const ref of imports) {
      if (ref.typeOnly || !known.has(ref.resolved)) continue;
      visit(ref.resolved, [...chain, path]);
    }
  };
  visit(input.target, []);
  return hits;
}
