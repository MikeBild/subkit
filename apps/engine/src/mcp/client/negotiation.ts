import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpClientLike, NegotiatedServerCapabilities } from "./pool.ts";

export const CLIENT_CAPABILITIES = {} as const;

export function captureNegotiatedProtocolVersion(transport: Transport): () => string | null {
  let negotiated: string | null = null;
  const original = transport.setProtocolVersion?.bind(transport);
  transport.setProtocolVersion = (version: string) => {
    negotiated = version;
    original?.(version);
  };
  return () => negotiated;
}

export function negotiatedCapabilities(client: McpClientLike): NegotiatedServerCapabilities | null {
  const declared = client.getServerCapabilities?.();
  if (!declared) return null;
  return {
    tools: declared.tools != null,
    resources: declared.resources != null,
    prompts: declared.prompts != null,
  };
}
