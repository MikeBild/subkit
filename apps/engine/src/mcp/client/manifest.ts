// Tool-manifest parsing, fingerprinting and budget capping for external
// MCP servers.
//
// Split out of pool.ts because none of it touches a connection: given a
// list of remote tool descriptors these functions are pure (modulo the
// tenant config read for the cap and one log line). The pool owns sockets,
// handshakes and backoff; this file owns "what does this manifest look
// like, and how much of it fits".
//
// A REMOTE MANIFEST IS UNTRUSTED INPUT. It is authored by a third party,
// can change between two handshakes, and is spent on the model's context
// budget. So it is parsed rather than cast (`parseRemoteManifest`),
// deduplicated on tool name, size-capped per server, and fingerprinted
// with a VERSIONED hash so a change in what we fingerprint is legible as
// exactly that rather than as remote drift.
//
// The HASH is a fingerprint of the manifest as a whole, so a remote that
// adds, drops or reshapes a tool changes it. `schema-drift.ts` compares
// the observed hash against the last persisted one — which is why the
// canonicalisation must be order-independent: a server that returns its
// tools in a different order on every call would otherwise look like it
// drifts on every handshake.

import { createHash } from "node:crypto";

import { z } from "zod";

import { getConfig } from "../../config/loader.ts";
import { logger } from "../../logging/logger.ts";

/** The five hints the MCP specification lets a server attach to a tool.
 *  Carried so the palette can SHOW what the server claims and an audit row
 *  can record it. Never a gate input — see `classifyMcpToolSideEffect` in
 *  packages/shared for why a remote does not get to classify its own
 *  writes. */
export interface RemoteToolAnnotations {
  title?: string | undefined;
  readOnlyHint?: boolean | undefined;
  destructiveHint?: boolean | undefined;
  idempotentHint?: boolean | undefined;
  openWorldHint?: boolean | undefined;
}

/** A remote tool, reduced to the fields the loop layer needs to convert
 *  it into an AI SDK `Tool`. `ai@6` ships no `createMCPClient`, so the
 *  loop does that conversion by hand from this descriptor. */
export interface RemoteToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** The server's display name for the tool, when it supplied one. */
  title?: string;
  annotations?: RemoteToolAnnotations;
  /**
   * The shape the server promises its `structuredContent` will match.
   *
   * ALREADY LOAD-BEARING, independently of this field: the SDK compiles a
   * validator per tool out of the `tools/list` reply and enforces it
   * inside `callTool`, so a tool that declares an output schema and then
   * answers without conforming structured content makes the call throw.
   * Carrying it here is what lets the palette tell the model the shape to
   * expect instead of the engine being the only party that knows.
   */
  outputSchema?: Record<string, unknown>;
}

const AnnotationsSchema = z
  .object({
    title: z.string().optional(),
    readOnlyHint: z.boolean().optional(),
    destructiveHint: z.boolean().optional(),
    idempotentHint: z.boolean().optional(),
    openWorldHint: z.boolean().optional(),
  })
  // Not `.strict()`: a server that adds a sixth hint must not lose its
  // five known ones. Unknown keys are dropped by the parse, which is the
  // point — they never reach the fingerprint or the model.
  .optional();

const JsonObjectSchema = z.record(z.string(), z.unknown());

/**
 * One remote tool as it arrives on the wire. Everything optional is
 * optional here too, because a server is free to omit it; what this schema
 * refuses is a tool with no usable name or a non-object input schema,
 * neither of which can be turned into a palette entry.
 */
const RemoteToolWireSchema = z.object({
  name: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: JsonObjectSchema,
  outputSchema: JsonObjectSchema.optional(),
  annotations: AnnotationsSchema,
});

export interface ParsedRemoteManifest {
  tools: RemoteToolDescriptor[];
  /** Tools the remote sent that could not be admitted, and why. Returned
   *  rather than only logged so the handshake can report a manifest that
   *  is partly unusable instead of silently shrinking. */
  rejected: Array<{ name: string; reason: "malformed" | "duplicate_name" }>;
}

/**
 * Parse and admit a `tools/list` reply.
 *
 * A malformed tool is DROPPED, not fatal: one bad entry must not blank a
 * server that also advertises twenty good ones, and failing the handshake
 * would park the whole server in backoff over a field we do not even need.
 *
 * DUPLICATE NAMES are a collision the protocol does not forbid and the
 * palette cannot represent — two entries would produce one
 * `mcp_<ns>__<tool>` key and the second would silently overwrite the
 * first. First occurrence wins, which is the only choice that is stable
 * across handshakes given the order-independent fingerprint.
 */
export function parseRemoteManifest(raw: readonly unknown[]): ParsedRemoteManifest {
  const tools: RemoteToolDescriptor[] = [];
  const rejected: ParsedRemoteManifest["rejected"] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    const parsed = RemoteToolWireSchema.safeParse(entry);
    if (!parsed.success) {
      const name = (entry as { name?: unknown } | null)?.name;
      rejected.push({ name: typeof name === "string" ? name : "<unnamed>", reason: "malformed" });
      continue;
    }
    const t = parsed.data;
    if (seen.has(t.name)) {
      rejected.push({ name: t.name, reason: "duplicate_name" });
      continue;
    }
    seen.add(t.name);
    tools.push({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema,
      ...(t.title !== undefined ? { title: t.title } : {}),
      ...(t.outputSchema !== undefined ? { outputSchema: t.outputSchema } : {}),
      ...(t.annotations !== undefined ? { annotations: t.annotations } : {}),
    });
  }
  return { tools, rejected };
}

/** The one method reading a manifest needs. Declared structurally so this
 *  module still depends on nothing that owns a socket — the pool passes
 *  its live client in, it does not live here. */
export interface ManifestListingClient {
  listTools(params?: { cursor?: string }): Promise<{
    tools: unknown[];
    nextCursor?: string | undefined;
  }>;
}

// `tools/list` is a paginated method. Not following `nextCursor` silently
// truncates a large server's manifest to its first page — the tools are
// simply absent from the palette with no signal. Following it WITHOUT a
// bound hands a server that always returns a cursor an unbounded read
// inside the handshake, which is the same wedge the per-call timeout
// exists to close, one layer up. So: follow, bounded. DEFAULT for the
// tenant-scoped `connectors.mcp.tools_list_max_pages` config leaf; the schema
// default mirrors this value.
export const TOOLS_LIST_MAX_PAGES = 5;

function toolsListMaxPages(tenant_id: string): number {
  try {
    return getConfig(tenant_id).connectors.mcp.tools_list_max_pages;
  } catch {
    return TOOLS_LIST_MAX_PAGES;
  }
}

/**
 * Read a remote's whole tool manifest, following `nextCursor` up to the
 * tenant's page bound. A server that keeps handing back a cursor is cut
 * off at the bound and logged — the pages already read are used, because a
 * partial palette beats no palette, and the log is what tells an operator
 * the bound needs raising.
 */
export async function listAllRemoteTools(
  tenant_id: string,
  namespace: string,
  mcp_server_id: string,
  client: ManifestListingClient,
): Promise<unknown[]> {
  const maxPages = toolsListMaxPages(tenant_id);
  const raw: unknown[] = [];
  let cursor: string | undefined;
  let page = 0;
  for (;;) {
    const listed = await client.listTools(cursor !== undefined ? { cursor } : undefined);
    raw.push(...listed.tools);
    page += 1;
    cursor = listed.nextCursor;
    if (cursor === undefined) break;
    if (page >= maxPages) {
      logger.warn({
        module: "mcp_client",
        action: "manifest.pagination_bound_reached",
        msg: "external MCP server kept paginating tools/list past the page bound; using the pages read so far",
        tenant_id,
        mcp_server_id,
        namespace,
        max_pages: maxPages,
        tool_count: raw.length,
      });
      break;
    }
  }
  return raw;
}

// A tool manifest, serialized, larger than this is truncated before it is
// handed to the loop layer (which spends it on the prompt budget). ~30 KB
// per server keeps a handful of registered servers from blowing the
// context window on their own. DEFAULT for the tenant-scoped
// `connectors.mcp.per_server_manifest_byte_cap` config leaf (read at use via
// `manifestByteCap`); the schema default mirrors this value.
export const PER_SERVER_MANIFEST_BYTE_CAP = 30_000;

/**
 * Version tag on every manifest fingerprint.
 *
 * The hash covers a PROJECTION of the descriptor, and that projection can
 * change when the engine learns to carry a new field. Without a version
 * the first handshake after such a change is indistinguishable from the
 * remote having reshaped its tools, and every registered server would emit
 * a drift audit row for a change that happened on our side. With it,
 * `schema-drift.ts` can tell the two apart and treat a version change as a
 * new baseline rather than as evidence about the remote.
 *
 * Bump this whenever `manifestHashProjection` changes.
 */
export const MANIFEST_HASH_VERSION = "v2";

/** Extract the version prefix of a stored fingerprint, or null for a hash
 *  written before fingerprints carried one. */
export function manifestHashVersion(hash: string): string | null {
  const at = hash.indexOf(":");
  return at <= 0 ? null : hash.slice(0, at);
}

/** Effective per-server manifest byte cap for a tenant. Falls back to the
 *  module default when the config loader is not initialised (unit tests) —
 *  same guard pattern as loop.ts's `webSearchSetting`. */
export function manifestByteCap(tenant_id: string): number {
  try {
    return getConfig(tenant_id).connectors.mcp.per_server_manifest_byte_cap;
  } catch {
    return PER_SERVER_MANIFEST_BYTE_CAP;
  }
}

/** Canonical JSON of a value with object keys sorted recursively, so the
 *  manifest hash is stable regardless of remote key ordering. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/**
 * What the fingerprint covers.
 *
 * Everything a change in would change how the engine or the model treats
 * the tool: its identity, its prose, its input contract, its output
 * contract, and the hints it advertises. A server that silently flips
 * `readOnlyHint` or narrows its `outputSchema` has changed its contract
 * with us and an operator should see it.
 *
 * Server-supplied `_meta` is deliberately NOT included, and is not carried
 * on the descriptor at all: it is a free-form bag the specification puts
 * no stability requirement on, so a server that parks a request id or a
 * timestamp there would make the fingerprint flap on every handshake and
 * turn the drift detector into a per-turn noise source.
 */
function manifestHashProjection(tools: readonly RemoteToolDescriptor[]): unknown {
  return tools.map((t) => ({
    name: t.name,
    title: t.title ?? null,
    description: t.description,
    inputSchema: t.inputSchema,
    outputSchema: t.outputSchema ?? null,
    annotations: t.annotations ?? null,
  }));
}

export function hashManifest(tools: RemoteToolDescriptor[]): string {
  const digest = createHash("sha256")
    .update(canonicalJson(manifestHashProjection(tools)))
    .digest("hex");
  return `${MANIFEST_HASH_VERSION}:${digest}`;
}

/**
 * Apply the per-server manifest byte cap. When the serialized tool list
 * exceeds the cap, keep the MOST tools that fit, preferring to keep the
 * lighter ones (so the heaviest tools are dropped first). A server that
 * exposes at least one tool ALWAYS keeps at least its smallest tool —
 * even if that one tool alone is over the cap — so the server is never
 * silently reduced to an empty palette (it would then look like it has no
 * tools at all). Returns the (possibly truncated) tool list.
 *
 * SHEDDING BEFORE DROPPING. The descriptor now carries an output schema,
 * which can be as large as the input schema and costs the model a hint
 * rather than a capability. So an over-budget manifest first sheds every
 * `outputSchema` and re-measures; only if it is still over budget does it
 * start dropping whole tools. Losing the shape of a reply is strictly
 * better than losing the ability to make the call. Annotations are NEVER
 * shed: they are what the palette shows about a tool's claimed effects,
 * and a cap is not a reason to stop showing it.
 */
export function capManifest(
  tenant_id: string,
  namespace: string,
  mcp_server_id: string,
  tools: RemoteToolDescriptor[],
): RemoteToolDescriptor[] {
  // Per-tenant cap from `connectors.mcp.per_server_manifest_byte_cap`; the
  // same value drives the admission loop and the log line below.
  const effectiveCapBytes = manifestByteCap(tenant_id);
  if (canonicalJson(tools).length <= effectiveCapBytes) return tools;

  let candidates = tools;
  let shed_output_schemas = false;
  if (tools.some((t) => t.outputSchema !== undefined)) {
    candidates = tools.map(({ outputSchema: _dropped, ...rest }) => rest);
    shed_output_schemas = true;
    if (canonicalJson(candidates).length <= effectiveCapBytes) {
      logger.warn({
        module: "mcp_client",
        action: "manifest.output_schemas_shed",
        msg: "external MCP tool manifest exceeded per-server byte cap; dropped output schemas and kept every tool",
        tenant_id,
        mcp_server_id,
        namespace,
        cap_bytes: effectiveCapBytes,
        tool_count: candidates.length,
      });
      return candidates;
    }
  }

  // Sort ascending by serialized weight so we greedily admit the lightest
  // tools first and the heaviest are the ones dropped when the budget runs
  // out — fitting the most tools under the cap.
  const weighted = candidates
    .map((t) => ({ tool: t, weight: canonicalJson(t).length }))
    .sort((a, b) => a.weight - b.weight);
  const kept: RemoteToolDescriptor[] = [];
  let dropped = 0;
  for (const { tool } of weighted) {
    const candidate = [...kept, tool];
    if (canonicalJson(candidate).length > effectiveCapBytes) {
      dropped += 1;
      continue;
    }
    kept.push(tool);
  }
  // Never return empty: if even the single lightest tool is over the cap,
  // keep it anyway. An over-cap-but-present tool is recoverable downstream
  // (the loop's own truncation still applies); an empty manifest makes the
  // whole server vanish from the palette with no signal to the model.
  if (kept.length === 0 && weighted[0]) {
    kept.push(weighted[0].tool);
    dropped = candidates.length - 1;
  }
  logger.warn({
    module: "mcp_client",
    action: "manifest.token_cap_truncated",
    msg: "external MCP tool manifest exceeded per-server token cap; dropped heaviest tools, kept the lightest that fit",
    tenant_id,
    mcp_server_id,
    namespace,
    cap_bytes: effectiveCapBytes,
    original_tool_count: tools.length,
    kept_tool_count: kept.length,
    dropped_tool_count: dropped,
    shed_output_schemas,
  });
  return kept;
}
