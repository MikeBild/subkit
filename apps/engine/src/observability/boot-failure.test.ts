import { describe, expect, test } from "bun:test";
import { bootFailure } from "./boot-failure.ts";

describe("bootFailure", () => {
  test.each([
    ["listen", "listen EADDRINUSE: address already in use 127.0.0.1:3000", "Free the port"],
    ["boot_dependencies", "connect ECONNREFUSED 127.0.0.1:5432", "Start PostgreSQL"],
    ["migrations", 'password authentication failed for user "subkit"', "user and password"],
    ["crypto_assert", "MASTER_KEY must be 64 hex characters", "MASTER_KEY"],
    ["boot_dependencies", "object_store: EACCES: permission denied, mkdir", "write access"],
    ["migrations", "relation already exists", "--migrate"],
    ["queue_start", "pg-boss failed", "pgboss schema"],
  ])("%s: %s", (phase, cause, hint) => {
    const failure = bootFailure(phase, cause);
    expect(failure.phase).toBe(phase);
    expect(failure.cause).toBe(cause);
    expect(failure.next).toContain(hint);
  });

  test("an unknown phase still names a next step", () => {
    expect(bootFailure(null, "boom")).toEqual({
      phase: "unknown",
      cause: "boom",
      next: "Restart the engine; report the error with its trace_id if it repeats.",
    });
  });
});
