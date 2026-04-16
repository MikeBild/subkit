// Tunnel wire format — JSON frames exchanged over a single WebSocket.
//
// Every frame is a discriminated union keyed by `type`. The engine side
// and the agent side both validate incoming frames against `TunnelFrameSchema`
// so malformed payloads never reach the dispatch layer. Binary frames are
// not used for simplicity.

import { z } from "zod";

export const TunnelRegisterTargetSchema = z.object({
  name: z.string().min(1),
  local_base_url: z.string().min(1),
});

export const TunnelRegisterFrameSchema = z.object({
  type: z.literal("register"),
  agent_version: z.string().min(1),
  targets: z.array(TunnelRegisterTargetSchema).min(1),
});

export const TunnelRegisterAckFrameSchema = z.object({
  type: z.literal("register_ack"),
  tunnel_id: z.string().min(1),
});

export const TunnelRequestFrameSchema = z.object({
  type: z.literal("request"),
  request_id: z.string().min(1),
  target: z.string().min(1),
  method: z.string().min(1),
  path: z.string(),
  headers: z.record(z.string(), z.string()),
  body: z.string().nullable().optional(),
});

export const TunnelResponseFrameSchema = z.object({
  type: z.literal("response"),
  request_id: z.string().min(1),
  status: z.number().int(),
  headers: z.record(z.string(), z.string()),
  body: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
});

export const TunnelPingFrameSchema = z.object({
  type: z.literal("ping"),
  ts: z.number().int(),
});

export const TunnelPongFrameSchema = z.object({
  type: z.literal("pong"),
  ts: z.number().int(),
});

export const TunnelUnregisterFrameSchema = z.object({
  type: z.literal("unregister"),
  target: z.string().optional(),
});

export const TunnelErrorFrameSchema = z.object({
  type: z.literal("error"),
  code: z.string(),
  message: z.string(),
});

export const TunnelFrameSchema = z.discriminatedUnion("type", [
  TunnelRegisterFrameSchema,
  TunnelRegisterAckFrameSchema,
  TunnelRequestFrameSchema,
  TunnelResponseFrameSchema,
  TunnelPingFrameSchema,
  TunnelPongFrameSchema,
  TunnelUnregisterFrameSchema,
  TunnelErrorFrameSchema,
]);

export type TunnelFrame = z.infer<typeof TunnelFrameSchema>;
export type TunnelRegisterFrame = z.infer<typeof TunnelRegisterFrameSchema>;
export type TunnelRegisterAckFrame = z.infer<typeof TunnelRegisterAckFrameSchema>;
export type TunnelRequestFrame = z.infer<typeof TunnelRequestFrameSchema>;
export type TunnelResponseFrame = z.infer<typeof TunnelResponseFrameSchema>;
export type TunnelPingFrame = z.infer<typeof TunnelPingFrameSchema>;
export type TunnelPongFrame = z.infer<typeof TunnelPongFrameSchema>;
export type TunnelErrorFrame = z.infer<typeof TunnelErrorFrameSchema>;
export type TunnelUnregisterFrame = z.infer<typeof TunnelUnregisterFrameSchema>;

/** Encode a frame for wire transmission. */
export function encodeFrame(frame: TunnelFrame): string {
  return JSON.stringify(frame);
}

/**
 * Parse an incoming message into a validated frame or return an error
 * string describing why the payload was rejected. Never throws.
 */
export function decodeFrame(
  raw: string | ArrayBuffer | Uint8Array,
): { ok: true; frame: TunnelFrame } | { ok: false; error: string } {
  let text: string;
  try {
    if (typeof raw === "string") {
      text = raw;
    } else if (raw instanceof ArrayBuffer) {
      text = new TextDecoder().decode(raw);
    } else {
      text = new TextDecoder().decode(raw);
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `json: ${err instanceof Error ? err.message : String(err)}` };
  }
  const result = TunnelFrameSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: result.error.message };
  }
  return { ok: true, frame: result.data };
}
