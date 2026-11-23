import { apiRequest } from "@/api/client";
import {
  type AttentionSnooze,
  AttentionSnoozeSchema,
  type SnoozeAttentionBody,
  SnoozeAttentionBodySchema,
  UnsnoozeAttentionBodySchema,
} from "./attention-contract";

export async function snoozeAttention(body: SnoozeAttentionBody): Promise<AttentionSnooze> {
  return AttentionSnoozeSchema.parse(
    await apiRequest<unknown>("/v1/attention/snooze", {
      method: "POST",
      body: JSON.stringify(SnoozeAttentionBodySchema.parse(body)),
    }),
  );
}

export async function unsnoozeAttention(attention_key: string): Promise<AttentionSnooze> {
  return AttentionSnoozeSchema.parse(
    await apiRequest<unknown>("/v1/attention/unsnooze", {
      method: "POST",
      body: JSON.stringify(UnsnoozeAttentionBodySchema.parse({ attention_key })),
    }),
  );
}
