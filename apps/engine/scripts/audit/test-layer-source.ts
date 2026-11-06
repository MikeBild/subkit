import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  type AliasScope,
  isTestFile,
  parseTsconfigPaths,
  resolveSpecifier,
} from "./import-graph.ts";
import { collectImports } from "./imports.ts";
import { isSupportModule, type Layer, type LayerSource, partition } from "./test-layers.ts";

const SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SKIPPED = /(?:^|\/)(?:node_modules|dist|\.stryker-tmp)\//;
const MAX_BYTES = 1024 * 1024;
const TSCONFIGS = ["tsconfig.json", "apps/cockpit/tsconfig.json"];

export function repoSourceFiles(repo: string): string[] {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .filter((f) => f && SOURCE.test(f) && !SKIPPED.test(f) && existsSync(join(repo, f)));
}

export function aliasScopes(repo: string): AliasScope[] {
  return TSCONFIGS.filter((f) => existsSync(join(repo, f))).map((f) =>
    parseTsconfigPaths(
      f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "",
      readFileSync(join(repo, f), "utf8"),
    ),
  );
}

export function readRepoText(repo: string, rel: string): string | null {
  const abs = join(repo, rel);
  try {
    if (statSync(abs).size > MAX_BYTES) return null;
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

export function repoLayerSource(repo: string): LayerSource {
  const scopes = aliasScopes(repo);
  const exists = (p: string) => existsSync(join(repo, p));
  const texts = new Map<string, string | null>();
  const imports = new Map<string, string[]>();
  const text = (rel: string) => {
    if (!texts.has(rel)) texts.set(rel, readRepoText(repo, rel));
    return texts.get(rel) ?? null;
  };
  return {
    text,
    imports(rel) {
      let out = imports.get(rel);
      if (!out) {
        const body = text(rel);
        out =
          body === null
            ? []
            : collectImports(rel, body).map((ref) =>
                resolveSpecifier(rel, ref.specifier, scopes, exists),
              );
        imports.set(rel, out);
      }
      return out;
    },
  };
}

export function loadTestLayers(repo: string): Record<Layer, string[]> {
  const files = repoSourceFiles(repo);
  return partition(
    files.filter(isTestFile),
    files.filter((f) => !isTestFile(f) && isSupportModule(f)),
    repoLayerSource(repo),
  );
}
