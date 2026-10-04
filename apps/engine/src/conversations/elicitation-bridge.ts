import { z } from "@hono/zod-openapi";
import type { ElicitRequestFormParams } from "@modelcontextprotocol/sdk/types.js";

export type ElicitRequestedSchema = ElicitRequestFormParams["requestedSchema"];

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

export const ElicitOobParamsSchema = z.object({
  message: z.string().min(1),
  url: z.string().url(),
  elicitationId: z.string().min(1),
});
export type ElicitOobParams = z.infer<typeof ElicitOobParamsSchema>;

export const ElicitResultSchema = z.object({
  action: z.enum(["accept", "decline", "cancel"]),
  content: z.record(z.string(), z.unknown()).optional(),
});
export type ElicitationResult = z.infer<typeof ElicitResultSchema>;

export const FORM_FAST_CANCEL_MS = 2_000;

export class ElicitationUnsupportedError extends Error {
  readonly capability: "form" | "oob";
  constructor(capability: "form" | "oob") {
    super(`MCP client does not advertise elicitation capability: ${capability}`);
    this.name = "ElicitationUnsupportedError";
    this.capability = capability;
  }
}

export interface ElicitationBridge {
  readonly capabilities: { form: boolean; oob: boolean };

  elicitForm(params: ElicitFormParams): Promise<ElicitationResult>;

  elicitOob(params: ElicitOobParams): Promise<ElicitationResult>;
}
