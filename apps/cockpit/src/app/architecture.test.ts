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
  "components/cockpit": ["pages", "features", "api"],
  "components/cockpit/patterns": ["pages", "features", "api", "app"],
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
      if (target && target[1] !== own) out.add(`${relative(COCKPIT, file)} -> ${spec}`);
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

const DEBT = new Set<string>([
  "components/cockpit/create-refusal.ts -> @/api/client",
  "components/cockpit/patterns/data-table.tsx -> @/app/links",
  "components/cockpit/patterns/detail-page.tsx -> @/app/side-panel-model",
  "components/cockpit/patterns/page-header.tsx -> @/app/links",
  "components/cockpit/patterns/standalone-page.tsx -> @/app/standalone-controls",
  "components/cockpit/patterns/template-card.tsx -> @/app/links",
  "components/cockpit/patterns/use-error-detail.ts -> @/app/links",
  "components/cockpit/patterns/workspace-changed.tsx -> @/app/links",
]);

const INTERNAL_DEBT = new Set<string>([
  "app/actor-directory-model.ts -> @/features/admin/model",
  "app/actor-directory.ts -> @/features/audit/model",
  "app/side-panel.tsx -> @/features/audit/model",
  "features/catalog/api/catalog-metadata-api.ts -> @/features/workflows/model",
  "features/catalog/model/catalog-metadata-model.ts -> @/features/workflows/model",
  "features/catalog/ui/catalog-categories.tsx -> @/features/workflows/model",
  "features/catalog/ui/catalog-grouping.tsx -> @/features/workflows/model",
  "features/catalog/ui/catalog-metadata.tsx -> @/features/workflows/model",
  "features/catalog/ui/metadata-dialog.tsx -> @/features/workflows/model",
  "features/chat/hooks/questions.ts -> @/features/tasks/model",
  "features/chat/ui/task-run-line.tsx -> @/features/tasks/model",
  "features/connectors/connectors-page.tsx -> @/features/workflows/model",
  "features/connectors/model/connector-detail-model.ts -> @/features/usage/model",
  "features/connectors/model/connector-view-model.ts -> @/features/grants/model",
  "features/connectors/ui/connector-detail.tsx -> @/features/grants/model",
  "features/connectors/ui/connector-edit.tsx -> @/features/workflows/model",
  "features/decisions/ui/decision-card.tsx -> @/features/grants/model",
  "features/decisions/ui/skill-proposal-sheet.tsx -> @/features/knowledge/model",
  "features/grants/model/task-grant-model.ts -> @/features/workflows/model",
  "features/grants/ui/approval-expiry-note.tsx -> @/features/tasks/model",
  "features/grants/ui/grant-environment.tsx -> @/features/workflows/model",
  "features/grants/ui/grant-task-authority.tsx -> @/features/tasks/model",
  "features/grants/ui/task-permissions.tsx -> @/features/tasks/model",
  "features/knowledge/files.tsx -> @/features/workflows/model",
  "features/knowledge/hooks/use-source-list.ts -> @/features/workflows/model",
  "features/knowledge/inbox.tsx -> @/features/workflows/model",
  "features/knowledge/intake-dialogs.tsx -> @/features/workflows/model",
  "features/knowledge/shell.tsx -> @/features/workflows/model",
  "features/knowledge/skills.tsx -> @/features/workflows/model",
  "features/knowledge/ui/source-facts.tsx -> @/features/workflows/model",
  "features/knowledge/ui/sources-list.tsx -> @/features/workflows/model",
  "features/operations/schedule-model.ts -> @/features/workflows/model",
  "features/operations/ui/operations-bar.tsx -> @/features/usage/model",
  "features/operations/use-operations.ts -> @/features/workflows/model",
  "features/overview/model/overview-model.ts -> @/features/grants/model",
  "features/overview/model/overview-model.ts -> @/features/workflows/model",
  "features/pwa/ui/installation-import-dialog.tsx -> @/features/workflows/model",
  "features/runs/ui/runs-detail.tsx -> @/features/connectors/model",
  "features/runs/ui/runs-detail.tsx -> @/features/workflows/model",
  "features/settings/ui/package-dialogs.tsx -> @/features/workflows/model",
  "features/setup/invitation.tsx -> @/features/admin/model",
  "features/tasks/model/tasks-history.ts -> @/features/audit/model",
  "features/tasks/model/tasks-model.ts -> @/features/audit/model",
  "features/tasks/model/tasks-model.ts -> @/features/workflows/model",
  "features/tasks/ui/tasks-detail.tsx -> @/features/workflows/model",
  "features/tasks/ui/tasks-form.tsx -> @/features/workflows/model",
  "features/tasks/ui/tasks-list.tsx -> @/features/workflows/model",
  "features/usage/breakdown.tsx -> @/features/tasks/model",
  "features/usage/dialogs.tsx -> @/features/settings/model",
  "features/vault/page.tsx -> @/features/audit/model",
  "features/workflows/model/automation-panel-model.ts -> @/features/connectors/model",
  "features/workflows/model/automation-panel-model.ts -> @/features/grants/model",
  "features/workflows/ui/automation-panel.tsx -> @/features/grants/model",
  "features/workflows/ui/workflow-diagnosis.tsx -> @/features/grants/model",
  "features/workflows/ui/workflow-grants.tsx -> @/features/grants/model",
  "pages/catalog.tsx -> @/features/workflows/model",
  "pages/chat.tsx -> @/features/usage/model",
  "pages/invite.tsx -> @/features/setup/model",
  "pages/overview.tsx -> @/features/usage/model",
]);

const DEBT_CEILING = 8;
const INTERNAL_DEBT_CEILING = 59;

const INLINE_QUERY = /\buse(?:Query|Mutation)\s*\(/g;
const INLINE_QUERY_CEILING = 301;

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

  test("inline useQuery/useMutation in components only shrink (data loading moves to hooks)", () => {
    const inline = sources(COCKPIT)
      .filter((file) => file.endsWith(".tsx"))
      .reduce((n, file) => n + [...readFileSync(file, "utf8").matchAll(INLINE_QUERY)].length, 0);
    expect(inline).toBeLessThanOrEqual(INLINE_QUERY_CEILING);
  });

  test("every classified area still has files to check", () => {
    const areas = new Set(sources(COCKPIT).map(areaOf));
    expect(Object.keys(FORBIDDEN).filter((area) => !areas.has(area))).toEqual([]);
  });
});
