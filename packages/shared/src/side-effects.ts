// Side-effect classification — the ONE place that decides whether an
// operation reads or writes, keyed on the driver semantics, never on
// vendor keywords. Both the execution engine's hold-writes mechanism and
// the conversation/MCP confirm-gate consult this so the SAME operation
// gets the SAME safety treatment on every path (workflow step, direct
// `call_connector`, authoring chat). Pure and primitive-typed: it takes a
// minimal structural input and imports nothing from `apps/*`, so the
// conversations layer can use it without pulling in the execution
// machinery (per packages/shared/AGENTS.md).
//
//   - explicit `override` ALWAYS wins (the author's escape hatch for a
//     POST that is semantically a search, or a GET that mutates)
//   - GraphQL: `query` = read; `mutation` / `subscription` = write. The
//     operation is taken from the explicit operation or inferred from the
//     document's leading keyword (a bare `{ … }` shorthand is a query).
//   - SQL (postgres): SELECT-only statements = read (including every
//     statement in `also`); anything else = write.
//   - S3: GET / HEAD / LIST = read; PUT / DELETE = write.
//   - HTTP: GET / HEAD / OPTIONS = read; every other method = write
//     (RFC semantics).

export type SideEffect = "read" | "write";

export type GraphqlOperation = "query" | "mutation" | "subscription";

/** Minimal structural input — a superset that both a workflow
 *  `RequestStep` and a `call_connector` argument object can shape into.
 *  Only the fields relevant to the active driver need be set. */
export interface SideEffectInput {
  /** Author override; honored verbatim before any inference. */
  override?: SideEffect | null;
  /** HTTP / S3 method (defaults to GET when omitted). */
  method?: string | null;
  graphql?: { operation?: GraphqlOperation | null; query?: string | null } | null;
  sql?: { query: string; also?: ReadonlyArray<{ query: string }> } | null;
  /** Truthy when this is an S3 step (changes the read-method set). */
  s3?: boolean | null;
}

const S3_READ_METHODS = new Set(["GET", "HEAD", "LIST"]);

/** GET / HEAD / OPTIONS are the read (idempotent, body-less) HTTP
 *  methods; everything else mutates per RFC semantics. */
export function httpMethodIsRead(method: string): boolean {
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD" || m === "OPTIONS";
}

/** Leading-keyword GraphQL operation inference. Strips leading
 *  whitespace and `#` comments; a document that opens with the bare
 *  selection-set shorthand `{` is a query by spec. Exotic documents
 *  (fragment-first) fall back to "query" — authors cover those with an
 *  explicit operation or the `override`. */
export function inferGraphqlOperation(query: string): GraphqlOperation {
  const stripped = query.replace(/^(?:\s+|#[^\n]*\n?)+/, "");
  const m = /^(query|mutation|subscription)\b/i.exec(stripped);
  if (m) return m[1]!.toLowerCase() as GraphqlOperation;
  return "query";
}

/** True when the statement (after leading whitespace, `--` line comments
 *  and block comments) starts with SELECT. WITH-CTEs and everything else
 *  classify as write — conservative by design; `override: "read"` covers
 *  the author who knows better. */
export function sqlIsSelect(query: string): boolean {
  let s = query;
  for (;;) {
    const next = s
      .replace(/^\s+/, "")
      .replace(/^--[^\n]*\n?/, "")
      .replace(/^\/\*[\s\S]*?\*\//, "");
    if (next === s) break;
    s = next;
  }
  return /^select\b/i.test(s);
}

export function classifyHttpSideEffect(input: SideEffectInput): SideEffect {
  if (input.override) return input.override;
  if (input.graphql) {
    const op = input.graphql.operation ?? inferGraphqlOperation(input.graphql.query ?? "");
    return op === "query" ? "read" : "write";
  }
  if (input.sql) {
    const statements = [input.sql.query, ...(input.sql.also ?? []).map((s) => s.query)];
    return statements.every(sqlIsSelect) ? "read" : "write";
  }
  const method = (input.method ?? "GET").toUpperCase();
  if (input.s3) {
    return S3_READ_METHODS.has(method) ? "read" : "write";
  }
  return httpMethodIsRead(method) ? "read" : "write";
}
