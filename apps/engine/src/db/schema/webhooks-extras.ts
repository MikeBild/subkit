// P11: thin re-export of the P11 additions to `webhooks.ts`.
//
// The physical columns live on the existing `webhooks.ts` table
// definitions (so there is a single drizzle table per physical table);
// this file exists to satisfy the phase "files to create" layout and to
// give callers a focused barrel when they only need the P11 surface.

export {
  deliveries,
  subscriptions,
  webhookReplaySeen,
  webhooksInbound,
  webhooksOutbound,
} from "./webhooks.ts";
