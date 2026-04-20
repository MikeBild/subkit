// Route-doc parity gate.
//
// Cross-checks three artifacts that have to stay in lockstep:
//   1. The OpenAPI spec the engine actually mounts (source of truth).
//   2. The prose docs that list routes (docs/03-input-surfaces.md,
//      docs/05-connectors.md).
//   3. The slash-command registry in apps/sk/src/slash.ts (for the
//      docs/03-input-surfaces.md parity check).
//
// Breakage signals real drift: a docs reference to a route that was
// removed, or a new route that nobody documented. Known stable
// exceptions live on `WHITELIST` below — keep that list tight.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");

// Conservative regexes — match the route shapes that actually appear in
// our prose docs (no params expanded, no trailing slashes). The engine
// spec uses `{id}` style; the docs use either `{id}` or `:id`.
const ROUTE_RE = /(?:GET|POST|PUT|PATCH|DELETE)\s+\/v1\/[A-Za-z0-9/_:{}-]+/g;

function canonicalize(raw: string): string {
  return raw
    .replace(/:([a-z_]+)/gi, "{$1}")
    .replace(/\{\s*([a-z_]+)\s*\}/gi, "{$1}")
    .replace(/\/+$/, "")
    .trim()
    .toLowerCase();
}

function extractRoutes(text: string): Set<string> {
  const out = new Set<string>();
  const matches = text.match(ROUTE_RE);
  if (!matches) return out;
  for (const m of matches) {
    out.add(canonicalize(m));
  }
  return out;
}

function collectRoutesFromSource(files: string[]): Set<string> {
  const out = new Set<string>();
  for (const rel of files) {
    const text = readFileSync(join(REPO, rel), "utf8");
    // createRoute({ method, path }) + app.openapi(route, ...). Match
    // pairs where `method:` and `path:` sit within ~200 chars.
    const re = /method:\s*"(get|post|put|patch|delete)"[\s\S]{0,200}?path:\s*"(\/v1\/[^"]+)"/gi;
    let match: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: tight loop, common pattern
    while ((match = re.exec(text)) !== null) {
      const method = match[1]?.toUpperCase() ?? "";
      const path = match[2] ?? "";
      out.add(canonicalize(`${method} ${path}`));
    }
  }
  return out;
}

// Engine route source files that declare `/v1/...` paths via createRoute.
const ENGINE_ROUTE_FILES = [
  "apps/engine/src/http/routes/conversations.ts",
  "apps/engine/src/http/routes/connectors.ts",
  "apps/engine/src/http/routes/workflows.ts",
];

const DOC_FILES = ["docs/03-input-surfaces.md", "docs/05-connectors.md"];

// Routes that are intentionally mentioned in prose but implemented
// elsewhere (or referenced by shape only). Keep this list tight.
const WHITELIST: ReadonlySet<string> = new Set([
  // Workflow history endpoints live on workflows.ts; docs/17 references
  // them conversationally.
  "get /v1/workflows/{id}/history",
  "post /v1/workflows/{id}/restore/{version}",
]);

describe("route-doc parity", () => {
  test("every route prose-documented under conversations/connectors actually exists in engine routes", () => {
    const engine = collectRoutesFromSource(ENGINE_ROUTE_FILES);
    const docRoutes = new Set<string>();
    for (const doc of DOC_FILES) {
      for (const r of extractRoutes(readFileSync(join(REPO, doc), "utf8"))) {
        docRoutes.add(r);
      }
    }
    const missing: string[] = [];
    for (const r of docRoutes) {
      if (engine.has(r)) continue;
      if (WHITELIST.has(r)) continue;
      missing.push(r);
    }
    if (missing.length > 0) {
      throw new Error(
        `Docs reference routes that the engine does not mount:\n  ${missing.join("\n  ")}`,
      );
    }
    expect(missing).toHaveLength(0);
  });

  test("every slash command registered in sk also appears in docs/03-input-surfaces.md", () => {
    const slashSrc = readFileSync(join(REPO, "apps/sk/src/slash.ts"), "utf8");
    const cliDoc = readFileSync(join(REPO, "docs/03-input-surfaces.md"), "utf8");
    // Commands are declared inside the exported SLASH_COMMANDS array as
    // either inline objects `{ name: "x", ... }` or multi-line objects
    // whose first property is `name: "..."`. Match only entries whose
    // declaration is followed within the same object by a `category:`
    // key — filters out field-name decls that happen to share the
    // `name: "..."` shape (e.g. Fuse.js weight configs).
    const nameRe = /name:\s*"([a-z][a-z0-9-]*)"[\s\S]{0,400}?category:/g;
    const names = new Set<string>();
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: tight loop
    while ((m = nameRe.exec(slashSrc)) !== null) {
      if (m[1]) names.add(m[1]);
    }
    // Slash commands are referenced in the docs as `/name` — look for
    // each one. Alias-only names (e.g. "quit" for "exit") are allowed
    // to be missing; the primary name is what docs list.
    const missing: string[] = [];
    for (const name of names) {
      if (!cliDoc.includes(`/${name}`)) missing.push(name);
    }
    if (missing.length > 0) {
      throw new Error(
        `sk slash commands not documented in docs/03-input-surfaces.md:\n  /${missing.join("\n  /")}`,
      );
    }
    expect(missing).toHaveLength(0);
  });
});
