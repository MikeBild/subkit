import { describe, expect, test } from "bun:test";
import { localDatabaseUrl } from "../lib/local-database-url.ts";

describe("localDatabaseUrl", () => {
  test("uses the local defaults when no database URL is configured", () => {
    expect(localDatabaseUrl({})).toBe("postgres://subkit:subkit-local-only@localhost:5432/subkit");
  });

  test("matches Compose defaults for empty port and password values", () => {
    expect(localDatabaseUrl({ SUBKIT_DB_PORT: "", SUBKIT_DB_PASSWORD: "" })).toBe(
      "postgres://subkit:subkit-local-only@localhost:5432/subkit",
    );
  });

  test("uses the configured port and URL-safe password and rejects reserved characters", () => {
    expect(
      localDatabaseUrl({
        DATABASE_URL: "postgres://subkit:subkit@localhost:5432/subkit",
        SUBKIT_DB_PORT: "55432",
        SUBKIT_DB_PASSWORD: "local-password_~.",
      }),
    ).toBe("postgres://subkit:local-password_~.@localhost:55432/subkit");
    expect(() => localDatabaseUrl({ SUBKIT_DB_PASSWORD: "local@password" })).toThrow(
      "SUBKIT_DB_PASSWORD must use URL-unreserved characters only",
    );
  });

  test("preserves a custom database URL", () => {
    expect(
      localDatabaseUrl({
        DATABASE_URL: "postgres://custom:custom-pass@db.example.test:6543/custom",
        SUBKIT_DB_PORT: "55432",
      }),
    ).toBe("postgres://custom:custom-pass@db.example.test:6543/custom");
  });
});
