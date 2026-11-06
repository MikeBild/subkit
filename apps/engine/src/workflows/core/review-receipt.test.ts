import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  RECEIPT_PURGE_BATCH,
  type RetainedReceipt,
  receiptIsSpent,
  receiptsToPurge,
} from "./review-receipt.ts";

const NOW = new Date("2026-11-06T10:00:00.000Z");
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);
const receipt = (id: string, status: string, offsetMs: number): RetainedReceipt => ({
  id,
  status,
  expires_at: at(offsetMs),
});

const receiptArb = fc.record({
  id: fc.uuid(),
  status: fc.constantFrom("pending", "completed"),
  expires_at: fc.integer({ min: -3_600_000, max: 3_600_000 }).map(at),
});

describe("receiptIsSpent", () => {
  test("a completed receipt is spent even before it expires", () => {
    expect(receiptIsSpent(receipt("a", "completed", 60_000), NOW)).toBe(true);
  });

  test("a pending receipt is spent once its expiry has passed", () => {
    expect(receiptIsSpent(receipt("a", "pending", -1), NOW)).toBe(true);
    expect(receiptIsSpent(receipt("a", "pending", 0), NOW)).toBe(true);
    expect(receiptIsSpent(receipt("a", "pending", 1), NOW)).toBe(false);
  });
});

describe("receiptsToPurge", () => {
  test("purges completed and expired receipts and keeps open ones", () => {
    expect(
      receiptsToPurge(
        [
          receipt("done", "completed", 60_000),
          receipt("old", "pending", -60_000),
          receipt("open", "pending", 60_000),
        ],
        NOW,
      ),
    ).toEqual(["done", "old"]);
  });

  test("never purges the kept receipt", () => {
    expect(receiptsToPurge([receipt("done", "completed", 0)], NOW, "done")).toEqual([]);
    expect(
      receiptsToPurge([receipt("done", "completed", 0), receipt("x", "completed", 0)], NOW, "done"),
    ).toEqual(["x"]);
  });

  test("an empty set purges nothing", () => {
    expect(receiptsToPurge([], NOW)).toEqual([]);
  });

  test("one pass is bounded", () => {
    const many = Array.from({ length: RECEIPT_PURGE_BATCH + 3 }, (_, i) =>
      receipt(`r${i}`, "completed", 0),
    );
    const purged = receiptsToPurge(many, NOW);
    expect(purged).toHaveLength(RECEIPT_PURGE_BATCH);
    expect(purged[0]).toBe("r0");
  });

  test("purges exactly the spent receipts other than the kept one", () => {
    fc.assert(
      fc.property(
        fc.array(receiptArb, { maxLength: 30 }),
        fc.option(fc.uuid(), { nil: null }),
        (receipts, keep) => {
          const purged = new Set(receiptsToPurge(receipts, NOW, keep));
          for (const r of receipts) {
            expect(purged.has(r.id)).toBe(
              r.id !== keep &&
                receipts.some((o) => o.id === r.id && o.id !== keep && receiptIsSpent(o, NOW)),
            );
          }
          if (keep !== null) expect(purged.has(keep)).toBe(false);
        },
      ),
      { seed: 20261106, numRuns: 200 },
    );
  });

  test("a later clock never purges less", () => {
    fc.assert(
      fc.property(
        fc.array(receiptArb, { maxLength: 30 }),
        fc.nat({ max: 7_200_000 }),
        (receipts, laterMs) => {
          const earlier = new Set(receiptsToPurge(receipts, NOW));
          const later = new Set(receiptsToPurge(receipts, at(laterMs)));
          for (const id of earlier) expect(later.has(id)).toBe(true);
        },
      ),
      { seed: 20261106, numRuns: 200 },
    );
  });
});
