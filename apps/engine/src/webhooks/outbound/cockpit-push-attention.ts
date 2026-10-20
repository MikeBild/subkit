import { classifyEvent } from "../events/catalog.ts";

export function shouldDispatchCockpitPushAttention(eventType: string, payload: unknown): boolean {
  return classifyEvent(eventType, payload).actionable;
}
