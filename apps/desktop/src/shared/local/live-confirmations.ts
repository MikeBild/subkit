import { LocalConfirmationSchema } from "@shared/device/confirmation.ts";
import { z } from "zod";
import type { LiveDecision, LiveEvent } from "./live-view-model.ts";

export const CONFIRMATION_REQUESTED = "local.confirmation_requested";

const PendingAskSchema = z.object({
  confirmation_id: z.string().min(1),
  conversation_id: z.string().min(1),
  confirmation: LocalConfirmationSchema,
});
export type PendingAsk = z.infer<typeof PendingAskSchema>;

const PendingAsksSchema = z.object({ items: z.array(PendingAskSchema) });

export function requestedDevice(name: string, data: string): string | null {
  if (name !== CONFIRMATION_REQUESTED) return null;
  try {
    const body = JSON.parse(data) as { device_id?: unknown };
    return typeof body.device_id === "string" ? body.device_id : null;
  } catch {
    return null;
  }
}

export function pendingAsks(json: unknown): PendingAsk[] {
  const parsed = PendingAsksSchema.safeParse(json);
  return parsed.success ? parsed.data.items : [];
}

export function confirmationsPath(deviceId: string): string {
  return `/v1/devices/${encodeURIComponent(deviceId)}/confirmations`;
}

export function askedEvent(ask: PendingAsk, at: number): LiveEvent {
  return {
    type: "asked",
    command_id: ask.confirmation.command_id ?? ask.confirmation_id,
    confirmation_id: ask.confirmation_id,
    confirmation: ask.confirmation,
    at,
  };
}

export function respondPath(ask: Pick<PendingAsk, "conversation_id" | "confirmation_id">): string {
  return `/v1/conversations/${encodeURIComponent(ask.conversation_id)}/tool-calls/${encodeURIComponent(ask.confirmation_id)}/respond`;
}

export function respondBody(decision: LiveDecision): string {
  return JSON.stringify({ output: { confirmed: decision === "confirm" } });
}
