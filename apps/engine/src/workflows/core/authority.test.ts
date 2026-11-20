import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  AUTHORITY_REPLACEMENT_MAX_HOPS,
  AUTHORITY_WINDOW_MAX_DAYS,
  AUTHORITY_WINDOW_MAX_MS,
  type AuthorityBoundary,
  type AuthorityLiveness,
  carryForward,
  DAY_MS,
  isLive,
  isOpenEnded,
  remainingRuns,
  replacementFor,
  sameBoundary,
  windowValid,
} from "./authority.ts";

const FC = { seed: 20261106, numRuns: 200 } as const;

const T0 = new Date("2026-11-01T00:00:00.000Z");
const at = (days: number) => new Date(T0.getTime() + days * DAY_MS);

const live: AuthorityLiveness = {
  revoked_at: null,
  valid_from: T0,
  valid_until: at(10),
  max_runs: 5,
  reserved_runs: 2,
};

function boundary(id: string, overrides: Partial<AuthorityBoundary> = {}): AuthorityBoundary {
  return {
    id,
    workflow_id: "wf",
    workflow_version_id: "v1",
    execution_environment: "prod",
    effect_manifest_digest: "d1",
    max_runs: null,
    inherited_from: null,
    target_constraints: { targets: ["a"] },
    superseded_by: null,
    ...overrides,
  };
}

const livenessArb: fc.Arbitrary<AuthorityLiveness> = fc.record({
  revoked_at: fc.option(fc.constant(T0), { nil: null }),
  valid_from: fc.integer({ min: -20, max: 20 }).map(at),
  valid_until: fc.option(fc.integer({ min: -20, max: 40 }).map(at), { nil: null }),
  max_runs: fc.option(fc.integer({ min: 1, max: 10 }), { nil: null }),
  reserved_runs: fc.integer({ min: 0, max: 12 }),
});

const chainArb = fc
  .array(fc.boolean(), { minLength: 1, maxLength: AUTHORITY_REPLACEMENT_MAX_HOPS - 2 })
  .map((sameFlags) =>
    sameFlags.map((same, i) =>
      boundary(`a${i}`, {
        superseded_by: i + 1 < sameFlags.length ? `a${i + 1}` : null,
        ...(i > 0 && !same ? { effect_manifest_digest: "other" } : {}),
      }),
    ),
  );

describe("runs", () => {
  test("remainingRuns counts what is left and never goes negative", () => {
    expect(remainingRuns({ max_runs: null, reserved_runs: 9 })).toBeNull();
    expect(remainingRuns({ max_runs: 5, reserved_runs: 2 })).toBe(3);
    expect(remainingRuns({ max_runs: 5, reserved_runs: 9 })).toBe(0);
  });

  test("isOpenEnded needs neither a window end nor a run limit", () => {
    expect(isOpenEnded({ valid_until: null, max_runs: null })).toBe(true);
    expect(isOpenEnded({ valid_until: at(1), max_runs: null })).toBe(false);
    expect(isOpenEnded({ valid_until: null, max_runs: 1 })).toBe(false);
  });
});

describe("windowValid", () => {
  test("the hard limit is 31 days", () => {
    expect(AUTHORITY_WINDOW_MAX_DAYS).toBe(31);
    expect(AUTHORITY_WINDOW_MAX_MS).toBe(31 * DAY_MS);
  });

  test("accepts an open window and a bounded future window", () => {
    expect(windowValid(T0, null, at(100))).toBe(true);
    expect(windowValid(T0, at(31), T0)).toBe(true);
  });

  test("rejects reversed, expired and too long windows", () => {
    expect(windowValid(T0, T0, at(-1))).toBe(false);
    expect(windowValid(T0, at(2), at(3))).toBe(false);
    expect(windowValid(T0, at(2), at(2))).toBe(false);
    expect(windowValid(T0, new Date(at(31).getTime() + 1), T0)).toBe(false);
  });
});

describe("isLive", () => {
  test("a granted, unexpired authority with runs left is live", () => {
    expect(isLive(live, at(1))).toBe(true);
    expect(isLive({ ...live, valid_until: null, max_runs: null }, at(100))).toBe(true);
  });

  test("revoked, not yet valid, expired or exhausted authorities are not live", () => {
    expect(isLive({ ...live, revoked_at: T0 }, at(1))).toBe(false);
    expect(isLive(live, at(-1))).toBe(false);
    expect(isLive(live, at(10))).toBe(false);
    expect(isLive({ ...live, reserved_runs: 5 }, at(1))).toBe(false);
  });

  test("once valid, liveness only falls over time", () => {
    fc.assert(
      fc.property(
        livenessArb,
        fc.integer({ min: 0, max: 40 }),
        fc.integer({ min: 0, max: 40 }),
        (authority, a, b) => {
          const earlier = new Date(authority.valid_from.getTime() + Math.min(a, b) * DAY_MS);
          const later = new Date(authority.valid_from.getTime() + Math.max(a, b) * DAY_MS);
          if (isLive(authority, later)) expect(isLive(authority, earlier)).toBe(true);
        },
      ),
      FC,
    );
  });

  test("an authority whose window was valid at grant time is live until it ends", () => {
    fc.assert(
      fc.property(livenessArb, (authority) => {
        if (!windowValid(authority.valid_from, authority.valid_until, authority.valid_from)) return;
        const open = { ...authority, revoked_at: null, max_runs: null };
        expect(isLive(open, authority.valid_from)).toBe(true);
      }),
      FC,
    );
  });
});

describe("sameBoundary and replacementFor", () => {
  test("sameBoundary compares every boundary field", () => {
    const origin = boundary("a");
    expect(sameBoundary(boundary("b"), origin)).toBe(true);
    for (const change of [
      { workflow_id: "other" },
      { workflow_version_id: "v2" },
      { execution_environment: "dev" },
      { effect_manifest_digest: "d2" },
      { max_runs: 3 },
      { inherited_from: "a" },
      { target_constraints: { targets: ["b"] } },
    ] satisfies Partial<AuthorityBoundary>[]) {
      expect(sameBoundary(boundary("b", change), origin)).toBe(false);
    }
  });

  test("a successor keeps the boundary when it keeps or lifts the run limit", () => {
    const limited = boundary("a", { max_runs: 3 });
    expect(sameBoundary(boundary("b", { max_runs: 3 }), limited)).toBe(true);
    expect(sameBoundary(boundary("b", { max_runs: null }), limited)).toBe(true);
    expect(sameBoundary(boundary("b", { max_runs: 5 }), limited)).toBe(false);
    expect(sameBoundary(boundary("b", { max_runs: 3 }), boundary("a"))).toBe(false);
    expect(
      replacementFor([boundary("a", { max_runs: 3, superseded_by: "b" }), boundary("b")], "a"),
    ).toBe("b");
    expect(
      replacementFor([boundary("a", { superseded_by: "b" }), boundary("b", { max_runs: 3 })], "a"),
    ).toBe("a");
  });

  test("follows the supersede chain while the boundary stays the same", () => {
    const chain = [
      boundary("a", { superseded_by: "b" }),
      boundary("b", { superseded_by: "c" }),
      boundary("c", { superseded_by: "d", effect_manifest_digest: "d2" }),
      boundary("d"),
    ];
    expect(replacementFor(chain, "a")).toBe("b");
    expect(replacementFor(chain, "c")).toBe("c");
    expect(replacementFor(chain, "missing")).toBe("missing");
    expect(replacementFor([boundary("a", { superseded_by: "gone" })], "a")).toBe("a");
  });

  test("stops after the hop limit", () => {
    const chain = Array.from({ length: AUTHORITY_REPLACEMENT_MAX_HOPS + 5 }, (_, i) =>
      boundary(`a${i}`, { superseded_by: `a${i + 1}` }),
    );
    expect(replacementFor(chain, "a0")).toBe(`a${AUTHORITY_REPLACEMENT_MAX_HOPS}`);
  });

  test("sameBoundary is reflexive and symmetric for originals", () => {
    fc.assert(
      fc.property(chainArb, (chain) => {
        for (const a of chain) {
          expect(sameBoundary(a, a)).toBe(true);
          for (const b of chain) expect(sameBoundary(a, b)).toBe(sameBoundary(b, a));
        }
      }),
      FC,
    );
  });

  test("replacementFor is idempotent", () => {
    fc.assert(
      fc.property(chainArb, fc.nat(), (chain, pick) => {
        const origin = chain[pick % chain.length]!.id;
        const once = replacementFor(chain, origin);
        expect(replacementFor(chain, once)).toBe(once);
      }),
      FC,
    );
  });
});

describe("carryForward", () => {
  test("a grown boundary waits for a person", () => {
    expect(carryForward({ max_runs: 5, reserved_runs: 0, valid_until: null }, [{}])).toEqual({
      kind: "growth",
    });
  });

  test("an exhausted authority is not carried", () => {
    expect(carryForward({ max_runs: 5, reserved_runs: 5, valid_until: null }, [])).toEqual({
      kind: "exhausted",
    });
  });

  test("carries the remaining runs and the same window end", () => {
    expect(carryForward({ max_runs: 5, reserved_runs: 2, valid_until: at(3) }, [])).toEqual({
      kind: "carry",
      max_runs: 3,
      valid_until: at(3),
    });
    expect(carryForward({ max_runs: null, reserved_runs: 2, valid_until: null }, [])).toEqual({
      kind: "carry",
      max_runs: null,
      valid_until: null,
    });
  });

  test("never adds a boundary", () => {
    fc.assert(
      fc.property(livenessArb, fc.array(fc.constant({})), (parent, growth) => {
        const decision = carryForward(parent, growth);
        if (decision.kind !== "carry") return;
        expect(growth).toHaveLength(0);
        expect(decision.valid_until).toBe(parent.valid_until);
        if (parent.max_runs === null) expect(decision.max_runs).toBeNull();
        else {
          expect(decision.max_runs).not.toBeNull();
          expect(decision.max_runs!).toBeGreaterThan(0);
          expect(decision.max_runs!).toBeLessThanOrEqual(parent.max_runs);
        }
      }),
      FC,
    );
  });
});
