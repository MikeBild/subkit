// Route-doc parity gate.
//
// Cross-checks three artifacts that have to stay in lockstep:
//   1. The OpenAPI spec the engine actually mounts (source of truth).
//   2. The prose docs that list routes (docs/developers/input-surfaces.md,
//      docs/concepts/connectors.md).
//   3. The slash-command registry in apps/sk/src/slash.ts (parity-checked
//      against the generated docs/authors/slash-commands.md reference).
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
  // Two declaration styles coexist in the engine:
  //   1. createRoute({ method, path }) + app.openapi(route, ...) — the
  //      Zod-OpenAPI style used by most REST resources. `method:` and
  //      `path:` sit within ~200 chars.
  //   2. Raw Hono `app.<method>("/v1/...", handler)` — used by the MCP
  //      OAuth bridge endpoints (DCR, authorize, token, revoke), which
  //      are not part of the typed OpenAPI surface.
  const patterns = [
    /method:\s*"(get|post|put|patch|delete)"[\s\S]{0,200}?path:\s*"(\/v1\/[^"]+)"/gi,
    /app\.(get|post|put|patch|delete)\(\s*"(\/v1\/[^"]+)"/gi,
  ];
  for (const rel of files) {
    const text = readFileSync(join(REPO, rel), "utf8");
    for (const re of patterns) {
      let match: RegExpExecArray | null;
      // biome-ignore lint/suspicious/noAssignInExpressions: tight loop, common pattern
      while ((match = re.exec(text)) !== null) {
        const method = match[1]?.toUpperCase() ?? "";
        const path = match[2] ?? "";
        out.add(canonicalize(`${method} ${path}`));
      }
    }
  }
  return out;
}

// Engine route source files that declare `/v1/...` paths via createRoute.
// Some routes are split into per-sub-resource directories; we scan the
// directory's constituent files rather than a top-level module.
const ENGINE_ROUTE_FILES = [
  "apps/engine/src/http/routes/conversations/collection.ts",
  "apps/engine/src/http/routes/conversations/messages.ts",
  "apps/engine/src/http/routes/conversations/elicitations.ts",
  "apps/engine/src/http/routes/conversations/lifecycle.ts",
  "apps/engine/src/http/routes/conversations/tool-policies.ts",
  "apps/engine/src/http/routes/conversations/stream.ts",
  "apps/engine/src/http/routes/conversations/direct-tools.ts",
  "apps/engine/src/http/routes/connectors/collection.ts",
  "apps/engine/src/http/routes/connectors/test.ts",
  "apps/engine/src/http/routes/connectors/call.ts",
  "apps/engine/src/http/routes/connectors/oauth.ts",
  "apps/engine/src/http/routes/connectors/credentials.ts",
  "apps/engine/src/http/routes/connector-discovery.ts",
  "apps/engine/src/http/routes/executions/list.ts",
  "apps/engine/src/http/routes/executions/run.ts",
  "apps/engine/src/http/routes/executions/transform.ts",
  "apps/engine/src/http/routes/executions/cancel.ts",
  "apps/engine/src/http/routes/workflows.ts",
  // MCP OAuth 2.1 bridge endpoints — raw Hono routes (not createRoute).
  "apps/engine/src/http/routes/oauth/dcr.ts",
  "apps/engine/src/http/routes/oauth/consent.ts",
  "apps/engine/src/http/routes/oauth/token.ts",
];

const DOC_FILES = ["docs/developers/input-surfaces.md", "docs/concepts/connectors.md"];

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

  test("every slash command registered in sk also appears in docs/authors/slash-commands.md", () => {
    const slashSrc = readFileSync(join(REPO, "apps/sk/src/slash.ts"), "utf8");
    const cliDoc = readFileSync(join(REPO, "docs/authors/slash-commands.md"), "utf8");
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
        `sk slash commands not documented in docs/authors/slash-commands.md:\n  /${missing.join("\n  /")}`,
      );
    }
    expect(missing).toHaveLength(0);
  });
});
