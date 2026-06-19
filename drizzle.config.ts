import type { Config } from "drizzle-kit";

export default {
  schema: "./apps/engine/src/db/schema/index.ts",
  out: "./apps/engine/src/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://subkit:subkit@localhost:5432/subkit",
  },
  casing: "snake_case",
} satisfies Config;
