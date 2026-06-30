// MCP-native elicitation bridge — concrete implementation.
//
// Wraps an MCP `Server` + the per-request `RequestHandlerExtra` so a
// conversation tool running inside an MCP `tools/call` can issue a
// server→client `elicitation/create` request and await the operator's
// answer — without falling back to the DB-pause / `respondElicitation`
// round-trip. The bridge is the single seam between the engine's
// conversation tools and the MCP SDK's `server.elicitInput()`.
//
// ── Domain directionality ────────────────────────────────────────────
// The bridge CONTRACT — the `ElicitationBridge` interface plus its Zod
// param/result schemas — is owned by `conversations/` (see
// `conversations/elicitation-bridge.ts`). `conversations/*` tools depend
// on that contract; this `mcp/` module `implements` it. The `mcp/` side
// keeps the construction/transport logic only — its public surface is the
// `ElicitationBridge` class and the `createElicitationBridge` factory.
// Importers needing the contract symbols import them straight from
// `conversations/elicitation-bridge.ts`, the contract owner.
//
// ── Spec vocabulary ──────────────────────────────────────────────────
// MCP 2025-11-25 names the out-of-band mode `url`. The conversation-side
// interface still uses the older `elicitOob` method name, but this bridge
// sends `mode: "url"` on the wire.
//
// ── Capability derivation ────────────────────────────────────────────
// MCP 2025-11-25 distinguishes `elicitation.form` and `elicitation.url`.
// For backwards compatibility, an empty `elicitation` object means form-only.
// Servers must not send a mode the client did not advertise, so URL support
// is opt-in via `elicitation.url`.
//
// Advertising the capability is NOT a guarantee that the client will
// fulfil an elicitation/create round-trip — some clients advertise it yet
// never answer. So every elicit is best-effort and bounded by
// ELICIT_REQUEST_TIMEOUT_MS; past that window the caller falls back to the
// always-present confirm_tool_call responder.

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  ElicitResult,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import {
  type ElicitationBridge as ElicitationBridgeContract,
  type ElicitationResult,
  ElicitationUnsupportedError,
  type ElicitFormParams,
  ElicitFormParamsSchema,
  type ElicitOobParams,
  ElicitOobParamsSchema,
  ElicitResultSchema,
} from "../../conversations/elicitation-bridge.ts";

// Bound on a server→client elicitation/create round-trip. Advertising the
// elicitation capability does not guarantee the client answers it, so past
// this window we abort the elicitation (the SDK raises an McpError) and the
// caller falls back to the always-present confirm_tool_call responder. Kept
// well under the tools/call inline deadline so the client still receives a
// usable needs_confirm envelope rather than an engine-busy timeout.
const ELICIT_REQUEST_TIMEOUT_MS = 10_000;

export class ElicitationBridge implements ElicitationBridgeContract {
  /**
   * `oob` maps to the MCP wire `url` mode — see the file header.
   */
  readonly capabilities: { form: boolean; oob: boolean };

  constructor(
    private readonly server: Server,
    private readonly extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  ) {
    const elicitationCap = server.getClientCapabilities()?.elicitation;
    if (elicitationCap == null || typeof elicitationCap !== "object") {
      this.capabilities = { form: false, oob: false };
      return;
    }
    const cap = elicitationCap as { form?: unknown; url?: unknown };
    const keys = Object.keys(cap);
    this.capabilities = {
      form: keys.length === 0 || cap.form != null,
      oob: cap.url != null,
    };
  }

  /**
   * Issue a form-mode `elicitation/create` and await the client's
   * answer. Throws `ElicitationUnsupportedError` when the client did
   * not advertise the capability.
   */
  async elicitForm(rawParams: ElicitFormParams): Promise<ElicitationResult> {
    if (!this.capabilities.form) throw new ElicitationUnsupportedError("form");
    const params = ElicitFormParamsSchema.parse(rawParams);
    const result: ElicitResult = await this.server.elicitInput(
      {
        mode: "form",
        message: params.message,
        requestedSchema: params.requestedSchema,
      },
      { relatedRequestId: this.extra.requestId, timeout: ELICIT_REQUEST_TIMEOUT_MS },
    );
    return ElicitResultSchema.parse({
      action: result.action,
      ...(result.content ? { content: result.content } : {}),
    });
  }

  /**
   * Issue an out-of-band (URL) elicitation and await the client's
   * acknowledgement. Throws `ElicitationUnsupportedError` when the client
   * did not advertise the elicitation capability.
   *
   * Wire-mode note: the conversation contract's `Oob` name maps to MCP
   * 2025-11-25 URL-mode elicitation.
   */
  async elicitOob(rawParams: ElicitOobParams): Promise<ElicitationResult> {
    if (!this.capabilities.oob) throw new ElicitationUnsupportedError("oob");
    const params = ElicitOobParamsSchema.parse(rawParams);
    const result: ElicitResult = await this.server.elicitInput(
      {
        mode: "url",
        message: params.message,
        url: params.url,
        elicitationId: params.elicitationId,
      },
      { relatedRequestId: this.extra.requestId, timeout: ELICIT_REQUEST_TIMEOUT_MS },
    );
    return ElicitResultSchema.parse({
      action: result.action,
      ...(result.content ? { content: result.content } : {}),
    });
  }
}

/** Factory — keeps construction in one place for the CallTool handler. */
export function createElicitationBridge(
  server: Server,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
): ElicitationBridge {
  return new ElicitationBridge(server, extra);
}
