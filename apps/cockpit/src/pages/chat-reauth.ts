import type { ToolPart } from "@/components/ai-elements/tool";
import { toolNameOf } from "@/lib/tool-parts";

export interface ChatReauth {
  href: string;
  connectorId: string;
  label: string;
  expiresAt: string;
}

/**
 * The path of a one-time sign-in link: the connector's own sign-in route —
 * `/oauth/start` for a web service, `/mcp/authorize` for an MCP server —
 * opened with a single-use `?grant=`.
 */
export const SIGN_IN_LINK_PATH =
  /^\/v1\/connectors\/([0-9a-f-]{36})\/(?:oauth\/start|mcp\/authorize)$/i;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Consume the tool result directly, never a URL reconstructed by the model. */
export function chatReauth(tool: ToolPart, origin: string): ChatReauth | null {
  if (toolNameOf(tool) !== "request_connector_reauth" || tool.state !== "output-available")
    return null;
  const output = tool.output;
  if (!record(output) || output.ok === false) return null;
  const data = record(output.data) ? output.data : output;
  if (typeof data.reauth_url !== "string" || typeof data.expires_at !== "string") return null;
  try {
    const url = new URL(data.reauth_url);
    const match = SIGN_IN_LINK_PATH.exec(url.pathname);
    if (
      url.origin !== origin ||
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      !match?.[1] ||
      !url.searchParams.get("grant") ||
      !Number.isFinite(Date.parse(data.expires_at))
    )
      return null;
    return {
      href: data.reauth_url,
      connectorId: match[1],
      label: typeof data.connector === "string" ? data.connector : "",
      expiresAt: data.expires_at,
    };
  } catch {
    return null;
  }
}
