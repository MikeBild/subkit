// What a handshake actually negotiated.
//
// Separated from the pool because it answers a different question. The pool
// owns WHEN a session exists — connect, back off, evict, reuse. This module
// owns WHAT the two sides agreed on once one does: the protocol version and
// the server's declared capabilities. Both are read exactly once per
// handshake, and both are read in a way the SDK does not offer directly,
// which is the part worth keeping in one place with its reasoning attached.

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpClientLike, NegotiatedServerCapabilities } from "./pool.ts";

/** What the engine tells the server about ITSELF at `initialize`.
 *
 *  Deliberately EMPTY. A declared client capability is an invitation: a
 *  server that sees `sampling` will issue `sampling/createMessage`, one
 *  that sees `elicitation` will ask a human a question through a channel
 *  we do not operate, one that sees `roots` will ask for a filesystem we
 *  do not have. None of the three is implemented here, and advertising a
 *  capability without fulfilling it is a failure this repo has already
 *  paid for once on the inbound side. Passing the empty object explicitly
 *  — rather than omitting the argument — is what makes that a decision a
 *  reader can see instead of a default nobody chose. */
export const CLIENT_CAPABILITIES = {} as const;

/**
 * Observe the protocol version the two sides settled on at `initialize`.
 *
 * The SDK `Client` exposes the server's capabilities, implementation block
 * and instructions, but NOT the negotiated version: it hands that to the
 * TRANSPORT via `setProtocolVersion`, because an HTTP transport has to
 * echo it in a header on every subsequent request. Wrapping that one call
 * is therefore the only way to read the negotiated version without
 * re-issuing `initialize` ourselves — and re-issuing it would negotiate a
 * SECOND session whose answer need not match the one this client is using.
 *
 * The underlying implementation still runs. Swallowing it would strip the
 * `MCP-Protocol-Version` header off every request after the handshake.
 *
 * Returns a reader rather than a value: the SDK sets the version DURING
 * `client.connect`, so there is nothing to read until that resolves.
 */
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
