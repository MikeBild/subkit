import { apiCall } from "@/api/call";
import type { AttentionSnooze, SnoozeAttentionBody } from "./attention-contract";

export function snoozeAttention(body: SnoozeAttentionBody): Promise<AttentionSnooze> {
  return apiCall("post", "/v1/attention/snooze", { body });
}

export function unsnoozeAttention(attention_key: string): Promise<AttentionSnooze> {
  return apiCall("post", "/v1/attention/unsnooze", { body: { attention_key } });
}
