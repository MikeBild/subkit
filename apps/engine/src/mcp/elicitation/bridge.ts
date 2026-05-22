// MCP-native elicitation bridge.
//
// Wraps an MCP `Server` + the per-request `RequestHandlerExtra` so a
// conversation tool running inside an MCP `tools/call` can issue a
// server→client `elicitation/create` request and await the operator's
// answer — without falling back to the DB-pause / `respondElicitation`
// round-trip. The bridge is the single seam between the engine's
// conversation tools and the MCP SDK's `server.elicitInput()`.
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

import { z } from "@hono/zod-openapi";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  ElicitRequestFormParams,
  ElicitResult,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * A flat JSON-Schema object of primitive properties — the only shape
 * the MCP `elicitation/create` form mode accepts. Aliased to the SDK's
 * own `requestedSchema` type so the bridge stays in lock-step with the
 * installed SDK's primitive-property contract. Built by the
 * ask-user → primitive-schema mapper.
 */
export type ElicitRequestedSchema = ElicitRequestFormParams["requestedSchema"];

/** Public params for a form-mode elicitation. */
export const ElicitFormParamsSchema = z.object({
  message: z.string().min(1),
  requestedSchema: z.custom<ElicitRequestedSchema>(
    (v) =>
      typeof v === "object" &&
      v !== null &&
      (v as { type?: unknown }).type === "object" &&
      typeof (v as { properties?: unknown }).properties === "object",
  ),
});
export type ElicitFormParams = z.infer<typeof ElicitFormParamsSchema>;

/** Public params for an out-of-band (URL) elicitation. */
export const ElicitOobParamsSchema = z.object({
  message: z.string().min(1),
  url: z.string().url(),
  /** Opaque correlation id echoed back by the client. */
  elicitationId: z.string().min(1),
});
export type ElicitOobParams = z.infer<typeof ElicitOobParamsSchema>;

/** Normalized result of an elicitation round-trip. */
export const ElicitResultSchema = z.object({
  action: z.enum(["accept", "decline", "cancel"]),
  content: z.record(z.string(), z.unknown()).optional(),
});
export type ElicitationResult = z.infer<typeof ElicitResultSchema>;

/**
 * Thrown when a tool asks the bridge for a capability the connected
 * client did not advertise. Callers catch this and fall back to the
 * DB-pause path.
 */
export class ElicitationUnsupportedError extends Error {
  readonly capability: "form" | "oob";
  constructor(capability: "form" | "oob") {
    super(`MCP client does not advertise elicitation capability: ${capability}`);
    this.name = "ElicitationUnsupportedError";
    this.capability = capability;
  }
}

export class ElicitationBridge {
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
