import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ENGINE_CLIENT_DIR = join(import.meta.dir, "../../../../apps/subkit/src/engine-client");
const DIAGNOSTICS_PATHS_FILE = join(import.meta.dir, "../diagnostics-paths.ts");
const OPENAPI_JSON_PATH = join(import.meta.dir, "openapi.json");

type CallKind = "request" | "requestForm" | "stream" | "streamPost";

interface EndpointCall {
  method: string;
  path: string;
}

function loadSharedPathConstants(): Record<string, string> {
  const src = readFileSync(DIAGNOSTICS_PATHS_FILE, "utf8");
  const map: Record<string, string> = {};
  for (const m of src.matchAll(/export const ([A-Z0-9_]+)\s*=\s*"([^"]+)"/g)) {
    map[m[1] as string] = m[2] as string;
  }
  return map;
}

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

const TYPED_CALL_RE = /\.api\s*\.(GET|POST|PUT|PATCH|DELETE)\(\s*(["'`])([^"'`]+)\2/g;

function extractTypedCalls(src: string): EndpointCall[] {
  const out: EndpointCall[] = [];
  for (const m of src.matchAll(TYPED_CALL_RE)) {
    out.push({
      method: m[1] as string,
      path: (m[3] as string).replace(/\{[^}]+\}/g, "{param}"),
    });
  }
  return out;
}

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
  out.push(...extractTypedCalls(src));
  return out;
}

const RAW_FETCH_ENDPOINTS: EndpointCall[] = [
  { method: "GET", path: "/v1/files/{param}/content" },
  { method: "POST", path: "/v1/extract" },
  { method: "GET", path: "/v1/events/stream" },
];

const STREAM_ONLY_ENDPOINTS = new Set([
  "GET /v1/conversations/{param}/stream",
  "GET /v1/executions/{param}/stream",
  "GET /v1/audit-log/export.ndjson",
  "GET /v1/events/stream",
  "POST /v1/extract",
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

function engineClientSources(): string[] {
  return readdirSync(ENGINE_CLIENT_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((file) => readFileSync(join(ENGINE_CLIENT_DIR, file), "utf8"));
}

function extractCliEndpointPairs(): Set<string> {
  const constants = loadSharedPathConstants();
  const pairs = new Set<string>();
  for (const src of engineClientSources()) {
    for (const call of extractFromFile(src, constants)) {
      pairs.add(`${call.method.toUpperCase()} ${call.path}`);
    }
  }
  for (const call of RAW_FETCH_ENDPOINTS) {
    pairs.add(`${call.method.toUpperCase()} ${call.path}`);
  }
  return pairs;
}

const KNOWN_UNDOCUMENTED_ENDPOINTS: string[] = [];

describe("subkit CLI <-> engine OpenAPI contract", () => {
  test("the scanner still finds the subkit CLI's engine calls in both call forms", () => {
    const pairs = extractCliEndpointPairs();
    expect(pairs.size).toBeGreaterThan(150);
    const typed = new Set(
      engineClientSources().flatMap((src) =>
        extractTypedCalls(src).map((call) => `${call.method} ${call.path}`),
      ),
    );
    expect(typed.size).toBeGreaterThan(0);
    for (const pair of typed) expect(pairs.has(pair)).toBe(true);
  });

  test("the scanner reads request calls and typed api calls alike", () => {
    const src = [
      `this.request("GET", \`/v1/things/\${encodeURIComponent(id)}\`);`,
      'this.api.PATCH("/v1/things/{id}/parts/{part_id}", { params: { path: { id, part_id } } });',
      "this.api.DELETE(\n  '/v1/things/{id}',\n  { params: { path: { id } } },\n);",
      'this.api.POST("/v1/things", { body });',
      'this.api\n  .GET("/v1/things/{id}/state")\n  .then(({ data }) => data);',
    ].join("\n");
    expect(extractFromFile(src, {})).toEqual([
      { method: "GET", path: "/v1/things/{param}" },
      { method: "PATCH", path: "/v1/things/{param}/parts/{param}" },
      { method: "DELETE", path: "/v1/things/{param}" },
      { method: "POST", path: "/v1/things" },
      { method: "GET", path: "/v1/things/{param}/state" },
    ]);
  });

  test("every (method, path) the subkit CLI calls exists in the committed openapi.json", () => {
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

describe("request step union in the committed openapi.json", () => {
  const schemas = (
    JSON.parse(readFileSync(OPENAPI_JSON_PATH, "utf8")) as {
      components: {
        schemas: Record<
          string,
          { discriminator?: unknown; oneOf?: { $ref?: string }[]; required?: string[] }
        >;
      };
    }
  ).components.schemas;
  const components = ["Http", "Graphql", "Sql", "S3", "Sftp", "Mcp"];

  for (const suffix of ["", "Output"]) {
    test(`RequestStep${suffix} lists every protocol without a discriminator http may omit`, () => {
      const union = schemas[`RequestStep${suffix}`];
      expect(union?.discriminator).toBeUndefined();
      expect(union?.oneOf?.map((member) => member.$ref)).toEqual(
        components.map((name) => `#/components/schemas/${name}RequestStep${suffix}`),
      );
    });

    test(`only HttpRequestStep${suffix} may omit its protocol`, () => {
      const requiring = components.filter((name) =>
        schemas[`${name}RequestStep${suffix}`]?.required?.includes("protocol"),
      );
      expect(requiring).toEqual(components.filter((name) => name !== "Http"));
    });
  }
});

describe("notification channel deletion in the committed openapi.json", () => {
  test("documents the conflict response for channels targeted by notification rules", () => {
    const doc = JSON.parse(readFileSync(OPENAPI_JSON_PATH, "utf8"));
    expect(doc.paths["/v1/notifications/channels/{id}"].delete.responses["409"]).toEqual({
      description: "Channel still targeted by notification rules",
      content: {
        "application/json": { schema: { $ref: "#/components/schemas/Error" } },
      },
    });
  });
});
