// Elicitation-bridge contract — owned by `conversations/`.
//
// `conversations/*` tools (`ask_user_*`, `authenticate_oauth`) collect
// operator input. The contract allows a surface to offer an in-process
// server→client `elicitation/create` round-trip instead of the DB-pause /
// `respondElicitation` path — but NO surface currently constructs one:
// MCP is portal-only for write approvals and uses the DB-pause path for
// conversation elicitation, so the `elicitationBridge?` parameter is never
// populated and every caller degrades to the DB-pause path.
//
// The CONTRACT lives here, in `conversations/`, so a future concrete
// implementation depends inward on this shape and `conversations/*` never
// imports a transport type to describe the bridge it consumes.

import { z } from "@hono/zod-openapi";
import type { ElicitRequestFormParams } from "@modelcontextprotocol/sdk/types.js";

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

/**
 * The bridge contract a conversation tool depends on. No surface constructs
 * a concrete implementation today (MCP write approval is portal-only and MCP
 * conversation elicitation uses the DB-pause path) — callers receive
 * `undefined` and degrade accordingly. A future in-process surface would
 * `implement` this shape.
 */
export interface ElicitationBridge {
  /**
   * `form` / `oob` track which elicitation modes the connected client
   * advertised. With SDK 1.29 both track the presence of the single
   * `elicitation` capability object.
   */
  readonly capabilities: { form: boolean; oob: boolean };

  /**
   * Issue a form-mode `elicitation/create` and await the client's
   * answer. Throws `ElicitationUnsupportedError` when the client did
   * not advertise the capability.
   */
  elicitForm(params: ElicitFormParams): Promise<ElicitationResult>;

  /**
   * Issue an out-of-band (URL) elicitation and await the client's
   * acknowledgement. Throws `ElicitationUnsupportedError` when the
   * client did not advertise the elicitation capability.
   */
  elicitOob(params: ElicitOobParams): Promise<ElicitationResult>;
}
