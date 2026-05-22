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
// keeps the construction/transport logic only. Re-exported below so
// existing `mcp/`-side importers keep one import path.
//
// ── SDK-vs-spec discrepancy (intentional) ────────────────────────────
// The MCP spec prose calls out-of-band elicitation "oob", and this
// module names its method `elicitOob` to match that vocabulary. BUT the
// installed SDK (`@modelcontextprotocol/sdk` 1.29) ships
// `ElicitRequestURLParamsSchema` with `mode: z.literal("url")` — it
// REJECTS `mode: "oob"` on the wire. So `elicitOob` sends `mode: "url"`.
// The SDK contract wins over the spec prose; this is a deliberate,
// documented deviation, not a bug.
//
// ── Capability derivation ────────────────────────────────────────────
// SDK 1.29's `ClientCapabilities.elicitation` is a single (optional)
// object — there is NO separate sub-flag distinguishing form-capable
// from url/oob-capable clients. We therefore treat the PRESENCE of the
// `elicitation` capability object as both `form: true` AND `oob: true`.
// Clients that advertise elicitation at all (claude.ai, Cursor) accept
// both modes. If a future SDK adds a sub-flag, narrow `oob` here.

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

// Re-export the contract so existing `mcp/`-side importers (and tests)
// keep a single import path into the bridge.
export {
  type ElicitationBridge as ElicitationBridgeContract,
  type ElicitationResult,
  ElicitationUnsupportedError,
  type ElicitFormParams,
  ElicitFormParamsSchema,
  type ElicitOobParams,
  ElicitOobParamsSchema,
  type ElicitRequestedSchema,
  ElicitResultSchema,
} from "../../conversations/elicitation-bridge.ts";

export class ElicitationBridge implements ElicitationBridgeContract {
  /**
   * `form` and `oob` both track the presence of the single SDK 1.29
   * `elicitation` capability object — see the file header.
   */
  readonly capabilities: { form: boolean; oob: boolean };

  constructor(
    private readonly server: Server,
    private readonly extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  ) {
    const elicitationCap = server.getClientCapabilities()?.elicitation;
    const present = elicitationCap != null;
    this.capabilities = { form: present, oob: present };
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
      { relatedRequestId: this.extra.requestId },
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
   * Wire-mode note: although the MCP spec prose calls this "oob" (and the
   * method keeps that vocabulary), the installed SDK 1.29 ships
   * `ElicitRequestURLParamsSchema` with `mode: z.literal("url")` and
   * REJECTS `mode: "oob"`. This method therefore sends `mode: "url"` on
   * the wire — a deliberate, documented deviation, not a bug. If a future
   * SDK restores `"oob"`, change it here.
   */
  async elicitOob(rawParams: ElicitOobParams): Promise<ElicitationResult> {
    if (!this.capabilities.oob) throw new ElicitationUnsupportedError("oob");
    const params = ElicitOobParamsSchema.parse(rawParams);
    const result: ElicitResult = await this.server.elicitInput(
      {
        // `mode: "url"` — the SDK schema (ElicitRequestURLParamsSchema)
        // enforces "url"; the spec prose says "oob". Method name keeps
        // the spec vocabulary; the wire keeps the SDK contract.
        mode: "url",
        message: params.message,
        url: params.url,
        elicitationId: params.elicitationId,
      },
      { relatedRequestId: this.extra.requestId },
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
