import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { BunPlugin } from "bun";

const app = resolve(import.meta.dir, "..");
export const UI_SOURCE = resolve(app, "../../packages/ui/src");
export const SHARED_SOURCE = resolve(app, "../../packages/shared/src");

const ALIASES: readonly [string, string][] = [
  ["@ui/", UI_SOURCE],
  ["@shared/", SHARED_SOURCE],
];

export function insideUi(file: string): boolean {
  return file.startsWith(UI_SOURCE + sep);
}

export function insideShared(file: string): boolean {
  return file.startsWith(SHARED_SOURCE + sep);
}

type ExportTarget = string | { [condition: string]: ExportTarget } | null | undefined;

const PACKAGE_SPECIFIER = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(\/[\w.-]+)*$/i;

const ESM_CONDITIONS = ["browser", "import", "module", "default"];
const NODE_CJS_CONDITIONS = ["node", "require", "default"];

function pickTarget(target: ExportTarget, conditions: readonly string[]): string | null {
  if (typeof target === "string") return target;
  if (!target) return null;
  for (const condition of conditions) {
    const picked = pickTarget(target[condition], conditions);
    if (picked) return picked;
  }
  return null;
}

function resolvePackage(specifier: string, conditions: readonly string[]): string {
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? "");
  const subpath = specifier.slice(name.length);
  const directory = join(app, "node_modules", name);
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
    exports?: Record<string, ExportTarget> | string;
    module?: string;
  };
  const { exports } = manifest;
  const entry =
    typeof exports === "object" && exports
      ? pickTarget(exports[`.${subpath}`], conditions)
      : subpath === ""
        ? ((conditions === ESM_CONDITIONS ? manifest.module : undefined) ?? null)
        : null;
  return entry ? join(directory, entry) : Bun.resolveSync(specifier, app);
}

export function resolveUiImport(
  specifier: string,
  importer: string,
  conditions: readonly string[] = ESM_CONDITIONS,
): string | null {
  for (const [prefix, source] of ALIASES) {
    if (specifier.startsWith(prefix)) {
      return Bun.resolveSync(join(source, specifier.slice(prefix.length)), source);
    }
  }
  if (!insideUi(importer) && !insideShared(importer)) return null;
  if (!PACKAGE_SPECIFIER.test(specifier)) return null;
  if (specifier.startsWith(".") || specifier.startsWith("/")) return null;
  return resolvePackage(specifier, conditions);
}

export function uiResolve(): BunPlugin {
  return {
    name: "subkit-ui-resolve",
    setup(build) {
      const conditions =
        build.config.target !== "browser" && build.config.format === "cjs"
          ? NODE_CJS_CONDITIONS
          : ESM_CONDITIONS;
      build.onResolve({ filter: /^[@a-z]/ }, (args) => {
        const path = resolveUiImport(args.path, args.importer, conditions);
        return path ? { path } : undefined;
      });
    },
  };
}

const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']+)\2/g;

export function rewriteUiSource(source: string, file: string): string {
  return source.replace(SPECIFIER, (match, head: string, quote: string, specifier: string) => {
    const path = resolveUiImport(specifier, file);
    return path ? `${head}${quote}${path}${quote}` : match;
  });
}
