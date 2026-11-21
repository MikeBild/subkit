import type { Db } from "../db/client.ts";
import { errorFields, logger } from "../logging/index.ts";

export interface ConversationTurnRelease {
  db: Db;
  tenant_id: string;
  conversation_id: string;
  turn_id: string;
  state: "completed" | "failed" | "cancelled";
}

export type ConversationTurnReleaseListener = (release: ConversationTurnRelease) => Promise<void>;

const listeners = new Map<string, ConversationTurnReleaseListener>();

export function onConversationTurnReleased(
  name: string,
  listener: ConversationTurnReleaseListener | null,
): void {
  if (listener) listeners.set(name, listener);
  else listeners.delete(name);
}

export async function notifyConversationTurnReleased(
  release: ConversationTurnRelease,
): Promise<void> {
  for (const [name, listener] of listeners) {
    try {
      await listener(release);
    } catch (error) {
      logger.warn({
        module: "conversation",
        action: "turn.release_listener_failed",
        msg: "a listener for a finished conversation turn failed",
        tenant_id: release.tenant_id,
        conversation_id: release.conversation_id,
        turn_id: release.turn_id,
        listener: name,
        ...errorFields(error),
      });
    }
  }
}
