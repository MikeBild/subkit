// Transactional outbox. Domain writers call `writeEvent(tx, channel, type, payload)`
// inside the same transaction as their domain mutation. A dedicated LISTENER
// process (implemented in P4) reads this table via `LISTEN`/`NOTIFY` + cursor
// catch-up. See docs/security-governance.md for the replay protocol.

import {
  bigint,
  bigserial,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tenant_id: uuid("tenant_id").notNull(),
    channel: text("channel").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("events_channel_id_idx").on(t.channel, t.id),
    index("events_tenant_created_idx").on(t.tenant_id, t.created_at),
  ],
);

export const outboxCursors = pgTable(
  "outbox_cursors",
  {
    listener_id: text("listener_id").notNull(),
    channel: text("channel").notNull(),
    last_seen_id: bigint("last_seen_id", { mode: "number" }).default(0).notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.listener_id, t.channel] })],
);
