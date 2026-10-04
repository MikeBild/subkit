import { createHash } from "node:crypto";
import { z } from "zod";
import { getConfig } from "../../config/loader.ts";
import { logger } from "../../logging/logger.ts";

export interface RemoteToolAnnotations {
  title?: string | undefined;
  readOnlyHint?: boolean | undefined;
  destructiveHint?: boolean | undefined;
  idempotentHint?: boolean | undefined;
  openWorldHint?: boolean | undefined;
}

export interface RemoteToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  title?: string;
  annotations?: RemoteToolAnnotations;
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
  .optional();

const JsonObjectSchema = z.record(z.string(), z.unknown());

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
  rejected: Array<{ name: string; reason: "malformed" | "duplicate_name" }>;
}

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

export interface ManifestListingClient {
  listTools(params?: { cursor?: string }): Promise<{
    tools: unknown[];
    nextCursor?: string | undefined;
  }>;
}

export const TOOLS_LIST_MAX_PAGES = 5;

function toolsListMaxPages(tenant_id: string): number {
  try {
    return getConfig(tenant_id).connectors.mcp.tools_list_max_pages;
  } catch {
    return TOOLS_LIST_MAX_PAGES;
  }
}

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

export const PER_SERVER_MANIFEST_BYTE_CAP = 30_000;

export const MANIFEST_HASH_VERSION = "v2";

export function manifestHashVersion(hash: string): string | null {
  const at = hash.indexOf(":");
  return at <= 0 ? null : hash.slice(0, at);
}

export function manifestByteCap(tenant_id: string): number {
  try {
    return getConfig(tenant_id).connectors.mcp.per_server_manifest_byte_cap;
  } catch {
    return PER_SERVER_MANIFEST_BYTE_CAP;
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

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

export function capManifest(
  tenant_id: string,
  namespace: string,
  mcp_server_id: string,
  tools: RemoteToolDescriptor[],
): RemoteToolDescriptor[] {
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
