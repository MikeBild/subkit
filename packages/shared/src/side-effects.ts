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
//   - explicit `write` always wins. Explicit `read` can describe a
//     semantically read-only POST, but cannot downgrade PUT / PATCH /
//     DELETE or an S3 mutation; those transports are structurally writes.
//   - GraphQL: `query` = read; `mutation` / `subscription` = write. The
//     operation is taken from the explicit operation or inferred from the
//     document's leading keyword (a bare `{ … }` shorthand is a query).
//   - SQL (postgres): SELECT-only statements = read (including every
//     statement in `also`); anything else = write.
//   - S3: GET / HEAD / LIST = read; PUT / DELETE = write.
//   - MCP: `resources/read` and `prompts/get` = read; `tools/call` =
//     WRITE. See `mcp` below for why the tool call gets no benefit of the
//     doubt, and `classifyMcpToolSideEffect` for the strictly advisory
//     read of the remote's own annotations, which never reaches the gate.
//   - HTTP: GET / HEAD / OPTIONS = read; every other method = write
//     (RFC semantics).

export type SideEffect = "read" | "write";

export type GraphqlOperation = "query" | "mutation" | "subscription";

/** The three MCP operations a request step can address. Named after the
 *  step field, not the wire method, because this is what an author reads
 *  and writes. */
export type McpOperation = "call_tool" | "read_resource" | "get_prompt";

/** Minimal structural input — a superset that both a workflow
 *  `RequestStep` and a `call_connector` argument object can shape into.
 *  Only the fields relevant to the active driver need be set. */
export interface SideEffectInput {
  /** Author override; mutating HTTP/S3 verbs cannot be downgraded to read. */
  override?: SideEffect | null;
  /** HTTP / S3 method (defaults to GET when omitted). */
  method?: string | null;
  graphql?: { operation?: GraphqlOperation | null; query?: string | null } | null;
  sql?: { query: string; also?: ReadonlyArray<{ query: string }> } | null;
  /** Truthy when this is an S3 step (changes the read-method set). */
  s3?: boolean | null;
  /**
   * Present when the call goes to a remote MCP server.
   *
   * `resources/read` and `prompts/get` are read operations by the MCP
   * specification's own definition of them — one returns resource
   * contents, the other returns prompt messages — so they classify as
   * reads on the operation alone.
   *
   * `tools/call` gets NO such guarantee and therefore NO benefit of the
   * doubt: it classifies as a WRITE. The specification's `readOnlyHint`
   * is optional, unverified, and asserted by the very party whose
   * side effects it describes — treating its absence, or its presence,
   * as evidence would let a remote decide which of its own calls the
   * engine gates. An author who knows a specific tool is a search sets
   * `override: "read"`, which is a claim by someone inside the tenant.
   */
  mcp?: { operation: McpOperation } | null;
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

/**
 * The five hints an MCP server may attach to a tool it advertises. All of
 * them are the server's own claims about the server's own behaviour.
 */
export interface McpToolAnnotationHints {
  readOnlyHint?: boolean | undefined;
  destructiveHint?: boolean | undefined;
  idempotentHint?: boolean | undefined;
  openWorldHint?: boolean | undefined;
}

/**
 * ADVISORY classification of a remote tool from the annotations the remote
 * itself supplied. It answers "what does this server SAY this tool does",
 * for a description the model reads and a field an operator greps.
 *
 * IT IS NOT A GATE INPUT, and it is deliberately not reachable from
 * `classifyHttpSideEffect` — which is the function both the hold-writes
 * mechanism and the confirm gate consult, and which classifies EVERY
 * `tools/call` as a write regardless of what the remote claims. Threading
 * this verdict into that one would hand a third-party server the power to
 * declare its own writes exempt from confirmation. The MCP specification's
 * own schema says as much: the hints are not guaranteed faithful and a
 * client must not make tool-use decisions on annotations from an untrusted
 * server.
 *
 * The rule is therefore one-directional even within the advisory verdict:
 * a hint can only ESCALATE toward "write". Only an explicit
 * `readOnlyHint: true` that is not contradicted by `destructiveHint: true`
 * yields "read"; absent, partial and self-contradictory annotations all
 * yield "write".
 */
export function classifyMcpToolSideEffect(
  annotations: McpToolAnnotationHints | null | undefined,
): SideEffect {
  if (!annotations) return "write";
  if (annotations.destructiveHint === true) return "write";
  return annotations.readOnlyHint === true ? "read" : "write";
}

export function classifyHttpSideEffect(input: SideEffectInput): SideEffect {
  if (input.override === "write") return "write";
  if (input.override === "read" && readOverrideIsSafe(input)) return "read";
  if (input.mcp) {
    return input.mcp.operation === "call_tool" ? "write" : "read";
  }
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

function readOverrideIsSafe(input: SideEffectInput): boolean {
  if (input.mcp || input.graphql || input.sql) return true;
  const method = (input.method ?? "GET").toUpperCase();
  if (input.s3) return S3_READ_METHODS.has(method);
  return httpMethodIsRead(method) || method === "POST";
}
