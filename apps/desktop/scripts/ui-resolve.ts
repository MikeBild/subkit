import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { BunPlugin } from "bun";

const app = resolve(import.meta.dir, "..");
export const UI_SOURCE = resolve(app, "../../packages/ui/src");

export function insideUi(file: string): boolean {
  return file.startsWith(UI_SOURCE + sep);
}

type ExportTarget = string | { [condition: string]: ExportTarget } | null | undefined;

const ESM_CONDITIONS = ["browser", "import", "module", "default"];

function pickTarget(target: ExportTarget): string | null {
  if (typeof target === "string") return target;
  if (!target) return null;
  for (const condition of ESM_CONDITIONS) {
    const picked = pickTarget(target[condition]);
    if (picked) return picked;
  }
  return null;
}

function resolvePackage(specifier: string): string {
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
      ? pickTarget(exports[`.${subpath}`])
      : subpath === ""
        ? (manifest.module ?? null)
        : null;
  return entry ? join(directory, entry) : Bun.resolveSync(specifier, app);
}

export function resolveUiImport(specifier: string, importer: string): string | null {
  if (specifier.startsWith("@ui/")) {
    return Bun.resolveSync(join(UI_SOURCE, specifier.slice(4)), UI_SOURCE);
  }
  if (!insideUi(importer)) return null;
  if (specifier.startsWith(".") || specifier.startsWith("/")) return null;
  return resolvePackage(specifier);
}

export function uiResolve(): BunPlugin {
  return {
    name: "subkit-ui-resolve",
    setup(build) {
      build.onResolve({ filter: /^[@a-z]/ }, (args) => {
        const path = resolveUiImport(args.path, args.importer);
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
