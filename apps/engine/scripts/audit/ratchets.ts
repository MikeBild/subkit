import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type ts from "typescript";
import {
  type Budgets,
  compareBudgets,
  parseBudgets,
  renderBudgets,
  shrinkBudgets,
} from "./budgets.ts";
import { listFiles } from "./files.ts";
import { collectImportsFromSource, parseSource, resolveImport } from "./imports.ts";
import {
  conversationsLeafHits,
  dbImportHits,
  effectHits,
  getDbFallbackHits,
  isCorePath,
  isTestPath,
  lineCount,
  pureCoreImportHits,
  type ResolvedImport,
} from "./rules.ts";
import { routeSchemaHits, toolSchemaHits } from "./zod-boundaries.ts";

export const SIZE_LIMIT = 600;

const isTs = (p: string) => p.endsWith(".ts") || p.endsWith(".tsx");

export class SourceCache {
  private readonly texts = new Map<string, string>();
  private readonly trees = new Map<string, ts.SourceFile>();
  private readonly imports = new Map<string, ResolvedImport[]>();

  constructor(readonly repo: string) {}

  text(rel: string): string {
    let text = this.texts.get(rel);
    if (text === undefined) {
      text = readFileSync(join(this.repo, rel), "utf8");
      this.texts.set(rel, text);
    }
    return text;
  }

  tree(rel: string): ts.SourceFile {
    let sf = this.trees.get(rel);
    if (!sf) {
      sf = parseSource(rel, this.text(rel));
      this.trees.set(rel, sf);
    }
    return sf;
  }

  resolvedImports(rel: string): ResolvedImport[] {
    let refs = this.imports.get(rel);
    if (!refs) {
      const exists = (p: string) => existsSync(join(this.repo, p));
      refs = collectImportsFromSource(this.tree(rel)).map((imp) => ({
        ...imp,
        resolved: resolveImport(rel, imp.specifier, exists),
      }));
      this.imports.set(rel, refs);
    }
    return refs;
  }

  list(roots: readonly string[], predicate: (rel: string) => boolean): string[] {
    const out = new Set<string>();
    for (const root of roots) {
      for (const abs of listFiles(join(this.repo, root), (p) => isTs(p))) {
        const rel = relative(this.repo, abs);
        if (predicate(rel)) out.add(rel);
      }
    }
    return [...out].sort();
  }
}

export interface Ratchet {
  id: string;
  allowlist: string;
  rule: string;
  unit: string;
  measure(cache: SourceCache): Map<string, number>;
}

function countBy(files: readonly string[], count: (rel: string) => number): Map<string, number> {
  const out = new Map<string, number>();
  for (const rel of files) {
    const n = count(rel);
    if (n > 0) out.set(rel, n);
  }
  return out;
}

function oversized(cache: SourceCache, files: readonly string[]): Map<string, number> {
  return countBy(files, (rel) => {
    const lines = lineCount(cache.text(rel));
    return lines > SIZE_LIMIT ? lines : 0;
  });
}

const ENGINE = "apps/engine/src";

export const RATCHETS: readonly Ratchet[] = [
  {
    id: "route_size",
    allowlist: "route-size.txt",
    rule: `http/routes/**/*.ts above ${SIZE_LIMIT} lines; split per resource`,
    unit: "lines",
    measure: (cache) =>
      oversized(
        cache,
        cache.list([`${ENGINE}/http/routes`], (rel) => !isTestPath(rel)),
      ),
  },
  {
    id: "test_file_size",
    allowlist: "test-file-size.txt",
    rule: `*.test.ts(x) above ${SIZE_LIMIT} lines; split per behavior or move setup into test-helpers`,
    unit: "lines",
    measure: (cache) =>
      oversized(
        cache,
        cache.list(["apps", "packages", "tests", "scripts"], (rel) => /\.test\.tsx?$/.test(rel)),
      ),
  },
  {
    id: "no_db_in_routes_and_tools",
    allowlist: "db-in-routes-and-tools.txt",
    rule: "runtime drizzle-orm or db/schema import in http/routes/** or conversations/tools/**; move the query into the subsystem service",
    unit: "imports",
    measure: (cache) =>
      countBy(
        cache.list(
          [`${ENGINE}/http/routes`, `${ENGINE}/conversations/tools`],
          (rel) => !isTestPath(rel),
        ),
        (rel) => dbImportHits(cache.resolvedImports(rel)).length,
      ),
  },
  {
    id: "no_getdb_fallback",
    allowlist: "getdb-fallback.txt",
    rule: "`?? getDb()` in a service.ts; pass the executor explicitly",
    unit: "fallbacks",
    measure: (cache) =>
      countBy(
        cache.list([ENGINE], (rel) => rel.endsWith("/service.ts") && !isTestPath(rel)),
        (rel) => getDbFallbackHits(cache.tree(rel)).length,
      ),
  },
  {
    id: "pure_core",
    allowlist: "pure-core.txt",
    rule: "core.ts or core/** importing db/, llm/, audit/, queue/ or drizzle-orm, or reading Date.now, new Date(), Math.random, randomUUID, process.env",
    unit: "hits",
    measure: (cache) =>
      countBy(
        cache.list([ENGINE, "apps/sk/src", "packages"], (rel) => isCorePath(rel)),
        (rel) =>
          pureCoreImportHits(cache.resolvedImports(rel)).length +
          effectHits(cache.tree(rel)).length,
      ),
  },
  {
    id: "conversations_leaf",
    allowlist: "conversations-leaf.txt",
    rule: "production import of conversations/** from outside conversations/ other than conversations/tools/index.ts or conversations/types.ts",
    unit: "imports",
    measure: (cache) =>
      countBy(
        cache.list([ENGINE], (rel) => !isTestPath(rel)),
        (rel) => conversationsLeafHits(rel, cache.resolvedImports(rel)).length,
      ),
  },
  {
    id: "zod_at_boundaries",
    allowlist: "zod-at-boundaries.txt",
    rule: "createRoute handler in http/routes/** reading params, query or body without a matching request schema, or a ConversationTool without inputSchema",
    unit: "hits",
    measure: (cache) => {
      const routes = countBy(
        cache.list([`${ENGINE}/http/routes`], (rel) => !isTestPath(rel)),
        (rel) => routeSchemaHits(cache.tree(rel)).length,
      );
      const tools = countBy(
        cache.list([ENGINE], (rel) => !isTestPath(rel)),
        (rel) => toolSchemaHits(cache.tree(rel)).length,
      );
      const out = new Map(routes);
      for (const [rel, n] of tools) out.set(rel, (out.get(rel) ?? 0) + n);
      return out;
    },
  },
];

export interface RatchetResult {
  id: string;
  status: "PASS" | "FAIL";
  message: string;
}

function allowlistPath(repo: string, ratchet: Ratchet): string {
  return join(repo, "apps/engine/scripts/audit/allowlists", ratchet.allowlist);
}

function readBudgets(repo: string, ratchet: Ratchet): Budgets {
  try {
    return parseBudgets(readFileSync(allowlistPath(repo, ratchet), "utf8"));
  } catch {
    return new Map();
  }
}

export function createCache(repo: string): SourceCache {
  return new SourceCache(repo);
}

export function evaluateRatchet(repo: string, ratchet: Ratchet, cache: SourceCache): RatchetResult {
  const budgets = readBudgets(repo, ratchet);
  const report = compareBudgets(ratchet.measure(cache), budgets);
  const where = `apps/engine/scripts/audit/allowlists/${ratchet.allowlist}`;
  const staleNote =
    report.stale.length > 0
      ? `; ${report.stale.length} stale entr${report.stale.length === 1 ? "y" : "ies"} can be removed (--update-baseline)`
      : "";
  if (report.unlisted.length === 0 && report.grown.length === 0) {
    return {
      id: ratchet.id,
      status: "PASS",
      message: `${budgets.size} allowlisted in ${where}, none new or grown${staleNote}`,
    };
  }
  const lines = [
    ...report.unlisted.map((v) => `${v.path} (${v.measure} ${ratchet.unit}, not allowlisted)`),
    ...report.grown.map(
      (v) => `${v.path} (${v.measure} ${ratchet.unit}, allowlisted budget ${v.budget})`,
    ),
  ];
  return {
    id: ratchet.id,
    status: "FAIL",
    message: `${lines.length} file(s) with ${ratchet.rule}; allowlist budgets only shrink (${where}):\n  ${lines.join("\n  ")}`,
  };
}

export function writeRatchetBaseline(
  repo: string,
  ratchet: Ratchet,
  cache: SourceCache,
  acceptNew: boolean,
): number {
  const path = allowlistPath(repo, ratchet);
  const budgets = shrinkBudgets(
    readBudgets(repo, ratchet),
    ratchet.measure(cache),
    acceptNew || !existsSync(path),
  );
  const header = [
    `Burndown allowlist for the audit-invariants \`${ratchet.id}\` check.`,
    `Rule: ${ratchet.rule}.`,
    `Format: <path from repo root>  <budget in ${ratchet.unit}>. A listed file fails once it exceeds its budget;`,
    "an unlisted file fails at the first hit. Budgets only shrink: fix the file, then run",
    "`bun run apps/engine/scripts/audit-invariants.ts --update-baseline` (lowers budgets, drops fixed files).",
    "`--accept-new` also admits new offenders; use it only for a reviewed baseline reset.",
  ];
  writeFileSync(path, renderBudgets(header, budgets));
  return budgets.size;
}
