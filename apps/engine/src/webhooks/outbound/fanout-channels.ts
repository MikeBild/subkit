import type { OutboxChannel } from "../../db/index.ts";

export const WEBHOOK_FANOUT_CHANNELS = [
  "execution.status",
  "notification.emitted",
  "connector.oauth",
] as const satisfies readonly OutboxChannel[];
