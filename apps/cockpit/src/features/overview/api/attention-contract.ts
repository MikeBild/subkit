import type { components } from "@cli-core/engine-api/openapi";

export type Attention = components["schemas"]["AttentionV1"];
export type AttentionItem = components["schemas"]["AttentionItem"];
export type AttentionReason = AttentionItem["reason"];
export type SnoozedAttentionItem = components["schemas"]["SnoozedAttentionItem"];
export type SnoozeAttentionBody = components["schemas"]["SnoozeAttentionBody"];
export type AttentionSnooze = components["schemas"]["AttentionSnooze"];
