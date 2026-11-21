import type { DeviceCapability } from "@shared/device/protocol.ts";
import { RUNNER_ASSERTION_AUDIENCE } from "@shared/device/runner-wire.ts";
import { z } from "zod";

export const HEARTBEAT_INTERVAL_MS = 15_000;
export const TOKEN_REFRESH_MARGIN_MS = 60_000;

export function personalCapabilities(
  offered: readonly DeviceCapability[],
  switchedOn: boolean,
): DeviceCapability[] {
  return switchedOn ? [...new Set(offered)] : [];
}

export interface AssertionInput {
  device_runner_id: string;
  now: number;
  nonce: string;
}

export function assertionPayload(input: AssertionInput): string {
  return JSON.stringify({
    aud: RUNNER_ASSERTION_AUDIENCE,
    device_runner_id: input.device_runner_id,
    iat: new Date(input.now).toISOString(),
    nonce: input.nonce,
  });
}

export const TokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    expires_at: z.iso.datetime({ offset: true }),
  })
  .strict();
export type RunnerToken = z.infer<typeof TokenResponseSchema>;

export function needsToken(token: RunnerToken | null, now: number): boolean {
  return token === null || Date.parse(token.expires_at) - TOKEN_REFRESH_MARGIN_MS <= now;
}

export const StreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("command.available"), command_id: z.string().min(1) }).strict(),
  z.object({ type: z.literal("command.cancelled"), command_id: z.string().min(1) }).strict(),
  z.object({ type: z.literal("runner.revoked") }).strict(),
]);
export type StreamEvent = z.infer<typeof StreamEventSchema>;

export function parseStreamEvent(event: string, data: string): StreamEvent | null {
  let body: unknown;
  try {
    body = data ? JSON.parse(data) : {};
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const parsed = StreamEventSchema.safeParse({ ...body, type: event });
  return parsed.success ? parsed.data : null;
}
