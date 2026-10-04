import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import { getConfig } from "../../config/loader.ts";

export type McpTransportGuardResult =
  | { ok: true }
  | { ok: false; response: Response; reason: "invalid_origin" | "unsupported_protocol_version" };

function jsonRpcHttpError(status: number, message: string): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message },
      id: null,
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

function originOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

function allowedOriginsForRequest(req: Request): Set<string> {
  const origins = new Set<string>();
  origins.add(new URL(req.url).origin);
  try {
    const publicOrigin = originOf(getConfig().server.public_base_url);
    if (publicOrigin) origins.add(publicOrigin);
  } catch {}
  return origins;
}

export function validateMcpStreamableHttpRequest(req: Request): McpTransportGuardResult {
  const origin = req.headers.get("origin");
  if (origin !== null) {
    const parsedOrigin = originOf(origin);
    if (!parsedOrigin || !allowedOriginsForRequest(req).has(parsedOrigin)) {
      return {
        ok: false,
        reason: "invalid_origin",
        response: jsonRpcHttpError(403, "Forbidden: invalid Origin header"),
      };
    }
  }

  const protocolVersion = req.headers.get("mcp-protocol-version");
  if (protocolVersion !== null && !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
    return {
      ok: false,
      reason: "unsupported_protocol_version",
      response: jsonRpcHttpError(
        400,
        `Bad Request: Unsupported protocol version: ${protocolVersion}`,
      ),
    };
  }

  return { ok: true };
}

export const __test__ = { allowedOriginsForRequest, originOf };
