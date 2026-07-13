// Consumer-driven contract: every engine endpoint the `sk` CLI actually
// calls must exist in the committed `openapi.json` (the artifact
// `openapi.d.ts` — and therefore this package's exported types — are
// generated from). Type generation alone doesn't catch drift because it
// requires a manual `bun run gen:openapi-client`; this test reads the CLI's
// own source so a newly-added call is picked up without maintaining a
// hand-kept list.
//
// The CLI does not use `openapi-fetch` at runtime (see `client.ts`'s header
// comment — it exists to keep the compiled binary's module graph small).
// The real chokepoint is `EngineClient.request/.requestForm/.stream/
// .streamPost` in `apps/sk/src/engine-client.ts`, dispatched from the
// per-resource method groups under `apps/sk/src/engine-client/*.ts`. Scanning
// `openapi-fetch`-style `client.GET(...)` call sites (as a naive port of this
// test would) would find zero matches and pass vacuously — so this scans the
// actual call shape instead.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ENGINE_CLIENT_DIR = join(import.meta.dir, "../../../../apps/sk/src/engine-client");
const DIAGNOSTICS_PATHS_FILE = join(import.meta.dir, "../diagnostics-paths.ts");
const OPENAPI_JSON_PATH = join(import.meta.dir, "openapi.json");

type CallKind = "request" | "requestForm" | "stream" | "streamPost";

interface EndpointCall {
  method: string;
  path: string;
}

/** `DIAGNOSTICS_DRIFT_PATH` and friends: path constants shared between the
 *  engine route and this client so a rename breaks typecheck on both sides
 *  (see `diagnostics-paths.ts`'s own header comment). Resolved generically
 *  so a new constant added there is picked up automatically. */
function loadSharedPathConstants(): Record<string, string> {
  const src = readFileSync(DIAGNOSTICS_PATHS_FILE, "utf8");
  const map: Record<string, string> = {};
  for (const m of src.matchAll(/export const ([A-Z0-9_]+)\s*=\s*"([^"]+)"/g)) {
    map[m[1] as string] = m[2] as string;
  }
  return map;
}

/** Single-line `const NAME = \`...\`;` / `const NAME = "...";` aliases local
 *  to one engine-client file (e.g. `conversations.ts`'s `respondElicitation`
 *  builds `path` once and reuses it across a retry). */
function loadLocalPathConstants(src: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const m of src.matchAll(/const ([A-Za-z_$][\w$]*)\s*=\s*`([^`]*)`;/g)) {
    map[m[1] as string] = m[2] as string;
  }
  for (const m of src.matchAll(/const ([A-Za-z_$][\w$]*)\s*=\s*"([^"]*)";/g)) {
    map[m[1] as string] = m[2] as string;
  }
  return map;
}

/** Index just past the `${...}` span opened by the `{` at `src[openIdx]`.
 *  Depth-counts braces only (ignores backticks) — sufficient here because
 *  every nested-template case in this codebase (e.g. the ternary in
 *  `logsTailWindow`) has balanced braces inside the interpolation. */
function findMatchingBrace(src: string, openIdx: number): number {
  let depth = 1;
  let i = openIdx + 1;
  while (i < src.length && depth > 0) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") depth--;
    i++;
  }
  if (depth !== 0) throw new Error(`unbalanced braces from index ${openIdx} in template scan`);
  return i;
}

/** Reads a full template literal starting at `src[start] === '`'`, honoring
 *  nested `${...}` (including nested backticks inside those spans) so the
 *  scan doesn't terminate on an inner backtick. */
function readTemplateLiteral(src: string, start: number): { raw: string; end: number } {
  let i = start + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`") return { raw: src.slice(start + 1, i), end: i + 1 };
    if (c === "$" && src[i + 1] === "{") {
      i = findMatchingBrace(src, i + 1);
      continue;
    }
    i++;
  }
  throw new Error(`unterminated template literal starting at index ${start}`);
}

/** Normalizes a raw template body into an openapi-comparable path:
 *  `${encodeURIComponent(x)}` and bare `${ident}` become `{param}`; a
 *  resolvable path constant splices in its literal value; a `${qs}`-shaped
 *  tail (this codebase's own naming convention for the optional `?...`
 *  suffix — see settings.ts, workflows.ts, diagnostics.ts) truncates the
 *  rest, since it is query string, not path. */
function normalizeInterpolated(raw: string, constants: Record<string, string>): string {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === "$" && raw[i + 1] === "{") {
      const close = findMatchingBrace(raw, i + 1);
      const expr = raw.slice(i + 2, close - 1).trim();
      i = close;
      if (/^qs\b/.test(expr)) return out;
      const enc = expr.match(/^encodeURIComponent\(\s*([A-Za-z_$][\w$]*)\s*,?\s*\)$/);
      if (enc) {
        out += "{param}";
        continue;
      }
      if (/^[A-Za-z_$][\w$]*$/.test(expr)) {
        out +=
          constants[expr] !== undefined
            ? normalizeInterpolated(constants[expr], constants)
            : "{param}";
        continue;
      }
      // Anything more complex (ternary, etc.) is query/formatting, not a
      // path segment — stop here.
      return out;
    }
    out += raw[i];
    i++;
  }
  return out;
}

function parsePathArg(
  src: string,
  idx: number,
  constants: Record<string, string>,
  localConstants: Record<string, string>,
): { path: string; end: number } {
  let i = idx;
  while (/\s/.test(src[i] as string)) i++;
  const c = src[i];
  if (c === "`") {
    const { raw, end } = readTemplateLiteral(src, i);
    return { path: normalizeInterpolated(raw, constants), end };
  }
  if (c === '"' || c === "'") {
    let j = i + 1;
    while (src[j] !== c) j++;
    return { path: src.slice(i + 1, j), end: j + 1 };
  }
  const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
  if (!m) throw new Error(`cannot parse path argument at index ${i}`);
  const ident = m[0];
  const resolved = constants[ident] ?? localConstants[ident];
  if (resolved === undefined) {
    throw new Error(
      `unresolvable path identifier '${ident}' — add it to loadSharedPathConstants or as a local const`,
    );
  }
  return { path: normalizeInterpolated(resolved, constants), end: i + ident.length };
}

/** Scans one `engine-client/*.ts` file for `.request/.requestForm/.stream/
 *  .streamPost` call sites and extracts the (method, path) pair each one
 *  dispatches to. This is the chokepoint every sk CLI command routes
 *  through (see `engine-client.ts`'s header comment), so a new CLI call is
 *  picked up automatically without touching this test. */
function extractFromFile(src: string, constants: Record<string, string>): EndpointCall[] {
  const localConstants = loadLocalPathConstants(src);
  const out: EndpointCall[] = [];
  const callRe = /\.(requestForm|request|streamPost|stream)(?:<[^>]*>)?\(/g;
  let m: RegExpExecArray | null = callRe.exec(src);
  while (m !== null) {
    const kind = m[1] as CallKind;
    let cursor = m.index + m[0].length;
    if (kind === "request" || kind === "requestForm") {
      while (/\s/.test(src[cursor] as string)) cursor++;
      const quote = src[cursor];
      if (quote !== '"' && quote !== "'") {
        throw new Error(`expected quoted HTTP method literal at index ${cursor}`);
      }
      let j = cursor + 1;
      while (src[j] !== quote) j++;
      const method = src.slice(cursor + 1, j);
      cursor = j + 1;
      while (/\s/.test(src[cursor] as string)) cursor++;
      if (src[cursor] !== ",") throw new Error(`expected ',' after HTTP method at index ${cursor}`);
      const { path } = parsePathArg(src, cursor + 1, constants, localConstants);
      out.push({ method, path });
    } else {
      const method = kind === "streamPost" ? "POST" : "GET";
      const { path } = parsePathArg(src, cursor, constants, localConstants);
      out.push({ method, path });
    }
    m = callRe.exec(src);
  }
  return out;
}

/** Call sites that bypass the `.request/.stream` chokepoint via a raw
 *  `this.fetchImpl(...)` (byte bodies, presigned URLs, SSE readers) and so
 *  can't be regex-derived from the uniform call shape above. Small,
 *  low-churn, and pinned explicitly with a pointer to the source line —
 *  everything else is picked up automatically by `extractFromFile`. */
const RAW_FETCH_ENDPOINTS: EndpointCall[] = [
  // files.ts downloadFile(): GET `${this.base}/v1/files/${id}/content`.
  { method: "GET", path: "/v1/files/{param}/content" },
  // knowledge.ts extractFile(): POST `${this.base}/v1/extract` with a raw
  // byte body (bypasses the JSON `.request()` helper).
  { method: "POST", path: "/v1/extract" },
  // connectors.ts subscribeConnectorOAuthCallback(): GET
  // `${this.base}/v1/events/stream?...` — excluded below as SSE.
  { method: "GET", path: "/v1/events/stream" },
];

/** SSE / NDJSON endpoints are not representable in OpenAPI's JSON-schema
 *  response model and are deliberately absent from the generated spec (see
 *  `diagnostics-paths.ts`'s own comment: "the SSE stream is not modeled by
 *  the OpenAPI generator"). Excluded from the "must exist in openapi.json"
 *  check for that structural reason, not because the drift doesn't matter. */
const STREAM_ONLY_ENDPOINTS = new Set([
  "GET /v1/conversations/{param}/stream",
  "GET /v1/executions/{param}/stream",
  "GET /v1/audit-log/export.ndjson",
  "GET /v1/events/stream",
]);

function loadOpenApiPairs(): Set<string> {
  const doc = JSON.parse(readFileSync(OPENAPI_JSON_PATH, "utf8")) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const pairs = new Set<string>();
  for (const [path, methods] of Object.entries(doc.paths)) {
    const normalized = path.replace(/\{[^}]+\}/g, "{param}");
    for (const method of Object.keys(methods)) {
      pairs.add(`${method.toUpperCase()} ${normalized}`);
    }
  }
  return pairs;
}

function extractCliEndpointPairs(): Set<string> {
  const constants = loadSharedPathConstants();
  const files = readdirSync(ENGINE_CLIENT_DIR).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
  );
  const pairs = new Set<string>();
  for (const file of files) {
    const src = readFileSync(join(ENGINE_CLIENT_DIR, file), "utf8");
    for (const call of extractFromFile(src, constants)) {
      pairs.add(`${call.method.toUpperCase()} ${call.path}`);
    }
  }
  for (const call of RAW_FETCH_ENDPOINTS) {
    pairs.add(`${call.method.toUpperCase()} ${call.path}`);
  }
  return pairs;
}

// Known drift, pinned as a ratchet: routes the CLI calls that ARE live on
// the engine (verified against the Hono route registry) but bypass
// @hono/zod-openapi and so are absent from the generated spec. Exact pin —
// a new undocumented call fails this test, and documenting one of these
// routes fails it too until the entry is removed, so the list only
// ratchets down. The full engine-side set (including routes the CLI does
// not call) lives in
// apps/engine/src/http/tests/openapi-route-coverage.test.ts.
const KNOWN_UNDOCUMENTED_ENDPOINTS = [
  "DELETE /v1/rbac/grants/{param}",
  "DELETE /v1/rbac/groups/{param}",
  "DELETE /v1/rbac/groups/{param}/members/{param}",
  "DELETE /v1/rbac/groups/{param}/roles/{param}",
  "DELETE /v1/rbac/roles/{param}",
  "DELETE /v1/rbac/roles/{param}/permissions/{param}",
  "GET /v1/rbac/grants",
  "GET /v1/rbac/groups",
  "GET /v1/rbac/permissions",
  "GET /v1/rbac/roles",
  "GET /v1/rbac/roles/{param}",
  "PATCH /v1/rbac/groups/{param}",
  "PATCH /v1/rbac/roles/{param}",
  "POST /v1/discovery/runs",
  "POST /v1/extract",
  "POST /v1/knowledge-sources",
  "POST /v1/rbac/can",
  "POST /v1/rbac/grants",
  "POST /v1/rbac/groups",
  "POST /v1/rbac/groups/{param}/members/{param}",
  "POST /v1/rbac/groups/{param}/roles/{param}",
  "POST /v1/rbac/roles",
  "POST /v1/rbac/roles/{param}/permissions",
  "POST /v1/rbac/users/{param}/role",
];

describe("sk CLI <-> engine OpenAPI contract", () => {
  test("the scanner still finds the sk CLI's engine calls", () => {
    // Canary against a regex regression silently reducing this to a
    // vacuous pass: the CLI has 180+ real call sites as of this writing.
    const pairs = extractCliEndpointPairs();
    expect(pairs.size).toBeGreaterThan(150);
  });

  test("every (method, path) the sk CLI calls exists in the committed openapi.json", () => {
    const cliPairs = extractCliEndpointPairs();
    const openApiPairs = loadOpenApiPairs();
    const missing = [...cliPairs]
      .filter((pair) => !STREAM_ONLY_ENDPOINTS.has(pair))
      .filter((pair) => !openApiPairs.has(pair))
      .sort();
    expect(
      missing,
      `Undocumented-endpoint set changed. A NEW entry means the CLI calls a path that is ` +
        `either not registered on the engine at all (a live 404 bug — fix the path) or live but ` +
        `missing its @hono/zod-openapi registration (add the registration — do not grow ` +
        `KNOWN_UNDOCUMENTED_ENDPOINTS). A MISSING entry means the route got documented — remove ` +
        `it from KNOWN_UNDOCUMENTED_ENDPOINTS so the ratchet tightens.`,
    ).toEqual(KNOWN_UNDOCUMENTED_ENDPOINTS);
  });
});
