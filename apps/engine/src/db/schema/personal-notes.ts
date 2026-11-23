import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { bytea, tenantId, timestamps } from "./_common.ts";
import { conversationMessages, conversations } from "./conversations.ts";
import { tenants, users } from "./identity.ts";

export const PERSONAL_NOTE_AREAS = [
  "about",
  "preferences",
  "people",
  "routines",
  "lessons",
] as const;
export type PersonalNoteArea = (typeof PERSONAL_NOTE_AREAS)[number];

export const PERSONAL_NOTE_ORIGINS = ["stated", "inferred"] as const;
export type PersonalNoteOrigin = (typeof PERSONAL_NOTE_ORIGINS)[number];

export const PERSONAL_NOTE_FACT_KINDS = ["fact", "preference", "plan", "event"] as const;
export type PersonalNoteFactKind = (typeof PERSONAL_NOTE_FACT_KINDS)[number];

export const PERSONAL_NOTE_ARCHIVE_REASONS = [
  "superseded",
  "merged",
  "expired",
  "stale",
  "contradicted",
  "manual",
] as const;
export type PersonalNoteArchiveReason = (typeof PERSONAL_NOTE_ARCHIVE_REASONS)[number];

export const personalNotes = pgTable(
  "personal_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    area: text("area").$type<PersonalNoteArea>().notNull(),
    slug: text("slug").notNull(),
    origin: text("origin").$type<PersonalNoteOrigin>().notNull(),
    fact_kind: text("fact_kind").$type<PersonalNoteFactKind>().notNull().default("fact"),
    text_ciphertext: bytea("text_ciphertext").notNull(),
    text_iv: bytea("text_iv").notNull(),
    text_auth_tag: bytea("text_auth_tag").notNull(),
    abstract_ciphertext: bytea("abstract_ciphertext"),
    abstract_iv: bytea("abstract_iv"),
    abstract_auth_tag: bytea("abstract_auth_tag"),
    confirmed_at: timestamp("confirmed_at", { withTimezone: true }),
    valid_from: timestamp("valid_from", { withTimezone: true }),
    valid_until: timestamp("valid_until", { withTimezone: true }),
    expires_at: timestamp("expires_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    archived_at: timestamp("archived_at", { withTimezone: true }),
    archive_reason: text("archive_reason").$type<PersonalNoteArchiveReason>(),
    replaced_by: uuid("replaced_by").references((): AnyPgColumn => personalNotes.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("personal_notes_owner_address_key")
      .on(t.tenant_id, t.user_id, t.area, t.slug)
      .where(sql`${t.archived_at} IS NULL`),
    index("personal_notes_owner_idx").on(t.tenant_id, t.user_id, t.archived_at),
    index("personal_notes_replaced_by_idx").on(t.replaced_by),
    check(
      "personal_notes_area_check",
      sql`${t.area} IN ('about', 'preferences', 'people', 'routines', 'lessons')`,
    ),
    check("personal_notes_slug_check", sql`${t.slug} ~ '^[a-z0-9][a-z0-9-]{0,79}$'`),
    check("personal_notes_origin_check", sql`${t.origin} IN ('stated', 'inferred')`),
    check(
      "personal_notes_fact_kind_check",
      sql`${t.fact_kind} IN ('fact', 'preference', 'plan', 'event')`,
    ),
    check(
      "personal_notes_archive_check",
      sql`(${t.archived_at} IS NULL) = (${t.archive_reason} IS NULL) AND (${t.archive_reason} IS NULL OR ${t.archive_reason} IN ('superseded', 'merged', 'expired', 'stale', 'contradicted', 'manual'))`,
    ),
    check(
      "personal_notes_abstract_check",
      sql`(${t.abstract_ciphertext} IS NULL) = (${t.abstract_iv} IS NULL) AND (${t.abstract_ciphertext} IS NULL) = (${t.abstract_auth_tag} IS NULL)`,
    ),
    check("personal_notes_version_check", sql`${t.version} >= 1`),
  ],
);

export const personalNoteSources = pgTable(
  "personal_note_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    note_id: uuid("note_id")
      .notNull()
      .references(() => personalNotes.id, { onDelete: "cascade" }),
    message_id: uuid("message_id").references(() => conversationMessages.id, {
      onDelete: "set null",
    }),
    conversation_id: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    quote_ciphertext: bytea("quote_ciphertext").notNull(),
    quote_iv: bytea("quote_iv").notNull(),
    quote_auth_tag: bytea("quote_auth_tag").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("personal_note_sources_note_message_key").on(t.note_id, t.message_id),
    index("personal_note_sources_tenant_note_idx").on(t.tenant_id, t.note_id),
  ],
);
