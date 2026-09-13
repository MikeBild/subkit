// Unit tests for the transient-DB-error classifier + retry wrapper.
//
// Pure logic — no DB, no Docker. Covers:
//   - which error shapes count as transient (codes + codeless messages)
//   - which must NOT (real query/logic errors)
//   - retryTransient: retries transient up to `tries`, rethrows non-transient
//     immediately, returns on first success, rethrows the last transient error
//     once exhausted.

import { beforeEach, describe, expect, test } from "bun:test";

import {
  getMetrics,
  METRIC_NAMES,
  resetMetricsRegistryForTests,
} from "../../observability/metrics.ts";
import { isTransientDbError, retryTransient } from "../transient.ts";

describe("isTransientDbError — transient codes", () => {
  test("ECONNREFUSED (Node socket) → true", () => {
    expect(
      isTransientDbError(
        Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      ),
    ).toBe(true);
  });

  test("57P01 admin_shutdown → true", () => {
    expect(
      isTransientDbError(
        Object.assign(new Error("terminating connection due to administrator command"), {
          code: "57P01",
        }),
      ),
    ).toBe(true);
  });

  test("57P03 cannot_connect_now → true", () => {
    expect(
      isTransientDbError({ code: "57P03", message: "the database system is starting up" }),
    ).toBe(true);
  });

  test("08006 connection_failure → true", () => {
    expect(isTransientDbError({ code: "08006" })).toBe(true);
  });

  test("ECONNRESET → true", () => {
    expect(isTransientDbError({ code: "ECONNRESET" })).toBe(true);
  });
});

describe("isTransientDbError — codeless connection-teardown messages", () => {
  test('"Connection terminated unexpectedly" (no code) → true', () => {
    expect(isTransientDbError(new Error("Connection terminated unexpectedly"))).toBe(true);
  });

  test('"terminating connection due to administrator command" (no code) → true', () => {
    expect(
      isTransientDbError(new Error("terminating connection due to administrator command")),
    ).toBe(true);
  });
});

describe("isTransientDbError — NOT transient", () => {
  test("constraint violation (23505) → false", () => {
    expect(isTransientDbError({ code: "23505", message: "duplicate key value" })).toBe(false);
  });

  test("undefined table (42P01) → false", () => {
    expect(isTransientDbError({ code: "42P01" })).toBe(false);
  });

  test("plain logic error → false", () => {
    expect(isTransientDbError(new Error("Cannot read properties of undefined"))).toBe(false);
  });
});

describe("isTransientDbError — defensive", () => {
  test("null → false (no throw)", () => {
    expect(isTransientDbError(null)).toBe(false);
  });
  test("undefined → false (no throw)", () => {
    expect(isTransientDbError(undefined)).toBe(false);
  });
  test("{} → false (no throw)", () => {
    expect(isTransientDbError({})).toBe(false);
  });
  test("string → false (no throw)", () => {
    expect(isTransientDbError("ECONNREFUSED")).toBe(false);
  });
});

describe("retryTransient", () => {
  const transient = () => Object.assign(new Error("conn lost"), { code: "57P01" });

  test("returns on first success without retry", async () => {
    let calls = 0;
    const out = await retryTransient(async () => {
      calls++;
      return "ok";
    });
    expect(out).toBe("ok");
    expect(calls).toBe(1);
  });

  test("retries a transient failure then succeeds", async () => {
    let calls = 0;
    const out = await retryTransient(
      async () => {
        calls++;
        if (calls < 2) throw transient();
        return "recovered";
      },
      { startMs: 1, maxMs: 2 },
    );
    expect(out).toBe("recovered");
    expect(calls).toBe(2);
  });

  test("rethrows a non-transient error immediately (no retry)", async () => {
    let calls = 0;
    await expect(
      retryTransient(
        async () => {
          calls++;
          throw new Error("logic bug");
        },
        { startMs: 1 },
      ),
    ).rejects.toThrow("logic bug");
    expect(calls).toBe(1);
  });

  test("rethrows the last transient error after exhausting tries", async () => {
    let calls = 0;
    await expect(
      retryTransient(
        async () => {
          calls++;
          throw transient();
        },
        { tries: 3, startMs: 1, maxMs: 2 },
      ),
    ).rejects.toThrow("conn lost");
    expect(calls).toBe(3);
  });
});

describe("retryTransient — predictive metric", () => {
  beforeEach(() => {
    resetMetricsRegistryForTests();
  });

  const transient = () => Object.assign(new Error("conn lost"), { code: "57P01" });

  test("increments db_transient_retries_total once per backoff, labelled by pass", async () => {
    await expect(
      retryTransient(
        async () => {
          throw transient();
        },
        { tries: 3, startMs: 1, maxMs: 2, label: "drift_scan" },
      ),
    ).rejects.toThrow("conn lost");
    // 3 tries → 2 backoffs (the final try rethrows without a retry).
    const entry = getMetrics()
      .snapshot()
      .find((s) => s.name === METRIC_NAMES.DB_TRANSIENT_RETRIES_TOTAL);
    const sample = entry?.samples.find((s) => s.labels.label === "drift_scan");
    expect(sample?.value).toBe(2);
  });

  test("does not increment when the first attempt succeeds", async () => {
    await retryTransient(async () => "ok");
    const entry = getMetrics()
      .snapshot()
      .find((s) => s.name === METRIC_NAMES.DB_TRANSIENT_RETRIES_TOTAL);
    expect(entry?.samples.length ?? 0).toBe(0);
  });
});
