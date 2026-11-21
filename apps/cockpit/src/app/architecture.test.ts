import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");
const COCKPIT = join(ROOT, "apps/cockpit/src");
const UI = join(ROOT, "packages/ui/src");

function sources(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.(ts|tsx)$/.test(file) && !/\.test\.tsx?$/.test(file))
    .map((file) => join(dir, file));
}

function imports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1] ?? "");
}

type Layer =
  | "pages"
  | "features"
  | "app"
  | "cockpit"
  | "patterns"
  | "components"
  | "lib"
  | "api"
  | "ds"
  | "ds-lib"
  | "other";

function layerOfSpecifier(spec: string): Layer | null {
  if (spec.startsWith("@ui/lib/")) return "ds-lib";
  if (spec.startsWith("@ui/")) return "ds";
  if (!spec.startsWith("@/")) return null;
  const path = spec.slice(2);
  if (path.startsWith("pages/")) return "pages";
  if (path.startsWith("features/")) return "features";
  if (path.startsWith("app/")) return "app";
  if (path.startsWith("components/cockpit/patterns")) return "patterns";
  if (path.startsWith("components/cockpit/")) return "cockpit";
  if (path.startsWith("components/")) return "components";
  if (path.startsWith("lib/")) return "lib";
  if (path.startsWith("api/")) return "api";
  return "other";
}

function areaOf(file: string): string {
  const path = relative(COCKPIT, file);
  if (!path.includes("/")) return "root";
  if (path.startsWith("components/cockpit/patterns/")) return "components/cockpit/patterns";
  if (path.startsWith("components/cockpit/")) return "components/cockpit";
  if (path.startsWith("components/")) return "components";
  return path.slice(0, path.indexOf("/"));
}

const FORBIDDEN: Record<string, readonly Layer[]> = {
  root: [],
  app: [],
  pages: [],
  features: ["pages"],
  "components/cockpit": ["pages", "features"],
  "components/cockpit/patterns": ["pages", "features", "api"],
  components: ["pages", "features"],
  lib: ["pages", "features", "cockpit", "patterns", "components", "ds"],
  api: ["pages", "features", "cockpit", "patterns", "components", "ds"],
};

function cockpitViolations(): string[] {
  const out = new Set<string>();
  for (const file of sources(COCKPIT)) {
    const forbidden = FORBIDDEN[areaOf(file)] ?? [];
    for (const spec of imports(file)) {
      const layer = layerOfSpecifier(spec);
      if (layer && forbidden.includes(layer)) out.add(`${relative(COCKPIT, file)} -> ${spec}`);
    }
  }
  return [...out].sort();
}

function featureInternals(): string[] {
  const out = new Set<string>();
  for (const file of sources(COCKPIT)) {
    const own = relative(COCKPIT, file).match(/^features\/([^/]+)\//)?.[1];
    for (const spec of imports(file)) {
      const target = spec.match(/^@\/features\/([^/]+)\/(.+)$/);
      if (target && target[1] !== own && target[2] !== "model")
        out.add(`${relative(COCKPIT, file)} -> ${spec}`);
    }
  }
  return [...out].sort();
}

function unclassified(): string[] {
  const out = new Set<string>();
  for (const file of sources(COCKPIT)) {
    if (!(areaOf(file) in FORBIDDEN)) out.add(`area: ${relative(COCKPIT, file)}`);
    for (const spec of imports(file)) {
      if (layerOfSpecifier(spec) === "other") out.add(`${relative(COCKPIT, file)} -> ${spec}`);
    }
  }
  return [...out].sort();
}

const DEBT = new Set<string>([]);

const INTERNAL_DEBT = new Set<string>([]);

const DEBT_CEILING = 0;
const INTERNAL_DEBT_CEILING = 0;

describe("architecture: dependencies point downward", () => {
  test("packages/ui imports nothing from an app, an API or a domain module", () => {
    const leaks = sources(UI).flatMap((file) =>
      imports(file)
        .filter((spec) => /^(@\/|@engine|@shared|@cli-core|@chat-ui|\.\.\/\.\.\/\.\.\/)/.test(spec))
        .map((spec) => `${relative(UI, file)} -> ${spec}`),
    );
    expect(leaks).toEqual([]);
  });

  test("packages/ui makes no network calls", () => {
    const calls = sources(UI).filter((file) =>
      /\bfetch\(|XMLHttpRequest|WebSocket|EventSource/.test(readFileSync(file, "utf8")),
    );
    expect(calls.map((file) => relative(UI, file))).toEqual([]);
  });

  test("no layer imports a layer above it (except listed debt)", () => {
    expect(cockpitViolations().filter((v) => !DEBT.has(v))).toEqual([]);
  });

  test("listed debt still exists — a fixed import leaves the list", () => {
    const found = new Set(cockpitViolations());
    expect([...DEBT].filter((v) => !found.has(v))).toEqual([]);
  });

  test("other features are reached only through their index.ts", () => {
    expect(featureInternals().filter((v) => !INTERNAL_DEBT.has(v))).toEqual([]);
  });

  test("listed feature-internal debt still exists", () => {
    const found = new Set(featureInternals());
    expect([...INTERNAL_DEBT].filter((v) => !found.has(v))).toEqual([]);
  });

  test("the debt lists only shrink", () => {
    expect(DEBT.size).toBeLessThanOrEqual(DEBT_CEILING);
    expect(INTERNAL_DEBT.size).toBeLessThanOrEqual(INTERNAL_DEBT_CEILING);
  });

  test("pages hold only page components, models live in a feature or in lib", () => {
    const stray = readdirSync(join(COCKPIT, "pages"), { recursive: true, encoding: "utf8" })
      .filter((file) => /\.(ts|tsx)$/.test(file) && !/\.test\.tsx?$/.test(file))
      .filter((file) => file.includes("/") || !file.endsWith(".tsx"));
    expect(stray).toEqual([]);
  });

  test("every page is a route: the router or the entry mounts it", () => {
    const mounted = new Set(
      [join(COCKPIT, "app/router.tsx"), join(COCKPIT, "main.tsx")].flatMap((file) =>
        imports(file)
          .filter((spec) => spec.startsWith("@/pages/"))
          .map((spec) => spec.slice("@/pages/".length)),
      ),
    );
    const pages = readdirSync(join(COCKPIT, "pages"))
      .filter((file) => file.endsWith(".tsx") && !/\.test\.tsx$/.test(file))
      .map((file) => file.slice(0, -".tsx".length));
    expect(pages.filter((page) => !mounted.has(page))).toEqual([]);
  });

  test("app reaches pages only from the router", () => {
    const reach = sources(join(COCKPIT, "app"))
      .filter((file) => !file.endsWith("/router.tsx"))
      .flatMap((file) =>
        imports(file)
          .filter((spec) => layerOfSpecifier(spec) === "pages")
          .map((spec) => `${relative(COCKPIT, file)} -> ${spec}`),
      );
    expect(reach).toEqual([]);
  });

  test("a feature's model entry exports pure models only", () => {
    const impure: string[] = [];
    const features = readdirSync(join(COCKPIT, "features"));
    for (const feature of features) {
      const entry = join(COCKPIT, "features", feature, "model/index.ts");
      if (!existsSync(entry)) continue;
      for (const spec of imports(entry)) {
        if (spec.startsWith("@shared/")) continue;
        if (!spec.startsWith("./")) {
          impure.push(`${relative(COCKPIT, entry)} -> ${spec}`);
          continue;
        }
        const model = join(COCKPIT, "features", feature, "model", `${spec.slice(2)}.ts`);
        const source = existsSync(model) ? readFileSync(model, "utf8") : "";
        if (/^import (?!type )[^;]*?from "(@\/api\/[^"]*|react|@tanstack\/[^"]*)"/ms.test(source))
          impure.push(`${relative(COCKPIT, model)} is not pure`);
      }
    }
    expect(impure).toEqual([]);
  });

  test("every source file and every app import belongs to a classified layer", () => {
    expect(unclassified()).toEqual([]);
  });

  test("controls and hooks come from packages/ui, the Cockpit keeps no second set", () => {
    expect(existsSync(join(COCKPIT, "components/ui"))).toBe(false);
    expect(existsSync(join(COCKPIT, "hooks"))).toBe(false);
    expect(existsSync(join(COCKPIT, "queries"))).toBe(false);
  });

  test("every classified area still has files to check", () => {
    const areas = new Set(sources(COCKPIT).map(areaOf));
    expect(Object.keys(FORBIDDEN).filter((area) => !areas.has(area))).toEqual([]);
  });
});
