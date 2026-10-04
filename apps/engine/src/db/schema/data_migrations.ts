import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const dataMigrations = pgTable("data_migrations", {
  name: text("name").primaryKey(),
  applied_at: timestamp("applied_at", { withTimezone: true }).defaultNow().notNull(),
});
