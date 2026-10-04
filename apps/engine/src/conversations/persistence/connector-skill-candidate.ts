import { createHash } from "node:crypto";
import type { McpProbeManifest } from "../../connectors/drivers/mcp.ts";
import { getConnector } from "../../connectors/service.ts";
import { listResolvedConnectorTemplates } from "../../connectors/template-resolver.ts";
import type { Db } from "../../db/client.ts";
import { logger } from "../../logging/logger.ts";
import { scrubString } from "../../logging/scrub-secrets.ts";
import type { RemoteToolDescriptor } from "../../mcp/client/manifest.ts";
import { upsertFromSignal } from "../../skill-candidates/service.ts";
import type { PatternSignal } from "../../skill-candidates/types.ts";

const MAX_TOOLS = 30;
const MAX_TOOL_SUMMARY_CHARS = 160;
const MAX_DATA_PATHS = 20;
const MAX_PAGING_HINTS = 6;
const MAX_PAGING_HINT_CHARS = 200;
const MAX_INSTRUCTIONS_CHARS = 600;
const MAX_BODY_CHARS = 4_000;

export interface ConnectorCapabilityInput {
  connector: {
    id: string;
    slug: string;
    display_name: string;
    base_url: string | null;
    auth_type: string;
  };
  purpose?: string | null;
  manifest: McpProbeManifest;
}

const DATA_PATH_RE = /\b([a-z][a-z0-9+.-]*):\/\/[^\s,;"'`<>()[\]]+/gi;
const WEB_SCHEMES = new Set(["http", "https", "ws", "wss", "ftp"]);
const USERINFO_RE = /^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i;
const PAGING_RE =
  /\b(page|pages|paging|paginat\w*|cursor|continuation_token|next_page|offset|caps? at|per page)\b/i;

function hostOf(base_url: string | null): string | null {
  if (!base_url) return null;
  try {
    return new URL(base_url).host || null;
  } catch {
    return null;
  }
}

function sentences(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z`"'(])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function claimOf(tool: RemoteToolDescriptor): string {
  const hint = tool.annotations?.readOnlyHint;
  if (hint === true) return "reads";
  if (hint === false)
    return tool.annotations?.destructiveHint === true ? "writes, destructive" : "writes";
  return "no read/write claim";
}

export function extractDataPaths(tools: readonly RemoteToolDescriptor[]): string[] {
  const found = new Set<string>();
  for (const tool of tools) {
    for (const match of tool.description.matchAll(DATA_PATH_RE)) {
      const scheme = (match[1] ?? "").toLowerCase();
      if (WEB_SCHEMES.has(scheme)) continue;
      const path = match[0].replace(/[.:!?]+$/, "").replace(USERINFO_RE, "$1");
      if (path.length > scheme.length + 3) found.add(path);
    }
  }
  return [...found].sort().slice(0, MAX_DATA_PATHS);
}

export function extractPagingHints(tools: readonly RemoteToolDescriptor[]): string[] {
  const hints: string[] = [];
  const seen = new Set<string>();
  for (const tool of tools) {
    for (const sentence of sentences(tool.description)) {
      if (!PAGING_RE.test(sentence)) continue;
      const hint = `${tool.name}: ${clip(sentence, MAX_PAGING_HINT_CHARS)}`;
      if (seen.has(hint)) continue;
      seen.add(hint);
      hints.push(hint);
      if (hints.length >= MAX_PAGING_HINTS) return hints;
    }
  }
  return hints;
}

export function buildConnectorCapabilitySignal(input: ConnectorCapabilityInput): PatternSignal {
  const { connector, manifest } = input;
  const tools = [...manifest.tools].sort((a, b) => a.name.localeCompare(b.name));
  const host = hostOf(connector.base_url);
  const dataPaths = extractDataPaths(tools);
  const pagingHints = extractPagingHints(tools);

  const instructions = manifest.instructions?.trim()
    ? clip(manifest.instructions, MAX_INSTRUCTIONS_CHARS)
    : null;

  const startPath =
    [...dataPaths].filter((p) => !p.includes("{")).sort((a, b) => a.length - b.length)[0] ??
    dataPaths[0];
  const lead = startPath
    ? `Start at \`${startPath}\`, follow the ids it returns${pagingHints.length > 0 ? "; lists are paged" : ""}. Load before saying data is missing.`
    : "Which tools read and which write, and what the server says about itself — load this before the first call.";

  const head = [
    lead,
    `MCP connector '${connector.display_name}' (slug ${connector.slug})${host ? ` at ${host}` : ""}.`,
    ...(input.purpose?.trim() ? [`Purpose: ${clip(input.purpose, 300)}`] : []),
    `Sign-in: ${connector.auth_type === "none" ? "none" : `${connector.auth_type} — the credential is stored with the connector; never ask for it in chat`}.`,
    ...(dataPaths.length > 0
      ? [
          `Data paths the server names: ${dataPaths.map((p) => `\`${p}\``).join(", ")}.`,
          "Start from the paths that list things and follow the ids they return, one level at a time, before concluding that data is absent.",
        ]
      : []),
    ...(pagingHints.length > 0
      ? [
          "Paging, as the tool descriptions state it — a full page means there is more to fetch:",
          ...pagingHints.map((h) => `- ${h}`),
        ]
      : []),
    "Tools, with the server's own read/write claim:",
  ].map(scrubString);
  const tail = [
    ...(instructions
      ? [`Server instructions (quoted from the server, unverified): "${instructions}"`]
      : []),
    `Probe: the MCP handshake (initialize + tools/list) answered and listed ${tools.length} tool(s).`,
  ].map(scrubString);

  const MORE_LINE_RESERVE = 40;
  let budget =
    MAX_BODY_CHARS -
    [...head, ...tail].reduce((n, line) => n + line.length + 1, 0) -
    MORE_LINE_RESERVE;
  const toolLines: string[] = [];
  for (const tool of tools.slice(0, MAX_TOOLS)) {
    const summary = sentences(tool.description)[0] ?? "";
    const line = scrubString(
      `- ${tool.name} (${claimOf(tool)})${summary ? ` — ${clip(summary, MAX_TOOL_SUMMARY_CHARS)}` : ""}`,
    );
    if (line.length + 1 > budget) break;
    toolLines.push(line);
    budget -= line.length + 1;
  }
  if (toolLines.length < tools.length)
    toolLines.push(`- … and ${tools.length - toolLines.length} more`);

  const body = [...head, ...toolLines, ...tail].join("\n").slice(0, MAX_BODY_CHARS);

  const title = scrubString(`Navigating the '${connector.slug}' MCP server`);
  const fingerprint = createHash("sha256")
    .update(`connector_capability:${connector.id}:${body}`)
    .digest("hex")
    .slice(0, 32);

  return {
    pattern_kind: "connector_capability",
    scope: "connector",
    connector_id: connector.id,
    title,
    body,
    examples: dataPaths.slice(0, 3).map((p) => `read ${p}`),
    best_practices: [],
    pitfalls: [],
    doc_refs: [],
    fingerprint,
    confidence: "medium",
    evidence: [
      {
        evidence_type: "connector_probe_manifest",
        summary: `Green MCP handshake listed ${tools.length} tool(s) for connector '${connector.slug}'.`,
      },
    ],
  };
}

async function templateSeedsSkill(
  db: Db,
  tenant_id: string,
  template_slug: string | null,
): Promise<boolean> {
  if (!template_slug) return false;
  const templates = await listResolvedConnectorTemplates(db, tenant_id);
  const match = templates.find((entry) => entry.template.slug === template_slug);
  return Boolean(match?.template.default_skill);
}

export async function proposeConnectorCapabilityCandidate(args: {
  db: Db;
  tenant_id: string;
  conversation_id: string;
  connector_id: string;
  purpose?: string | null;
  manifest: McpProbeManifest;
}): Promise<string | null> {
  const { db, tenant_id, conversation_id, connector_id } = args;
  try {
    const connector = await getConnector(tenant_id, connector_id, db);
    if (connector?.driver !== "mcp") return null;
    if (await templateSeedsSkill(db, tenant_id, connector.template_slug)) return null;
    const signal = buildConnectorCapabilitySignal({
      connector,
      purpose: args.purpose ?? null,
      manifest: args.manifest,
    });
    const result = await upsertFromSignal(tenant_id, signal, db);
    if (result.action === "proposed" || result.action === "updated") {
      return `Skill candidate '${signal.title}' proposed — approve it with POST /v1/skill-candidates/${result.candidate_id}/approve`;
    }
    return null;
  } catch (err) {
    logger.warn({
      module: "conversation_persistence",
      action: "connector_save.skill_candidate_failed",
      msg: "connector-capability skill-candidate proposal failed — the saved connector is unaffected",
      tenant_id,
      conversation_id,
      connector_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
