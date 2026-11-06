import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  AFFIRM_RESUME_WINDOW_MS,
  decideRunEnvironment,
  decideTurn,
  resumableApprovalId,
  runReply,
  stepLine,
} from "./fast-path.ts";

const settings = { seed: 20261106, numRuns: 200 };

describe("fast path core properties", () => {
  test("only a category route may precede another route, and at most one", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (text) => {
        const routes = decideTurn(text);
        expect(routes.length).toBeLessThanOrEqual(2);
        if (routes.length === 2) expect(routes[0]?.kind).toBe("category");
        expect(routes.slice(1).every((r) => r.kind !== "category")).toBe(true);
      }),
      settings,
    );
  });

  test("surrounding whitespace never changes the routes", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("list workflows", "run nightly", "yes", "show the a workflows", "hi"),
        fc.stringMatching(/^[ \t\n]{0,4}$/),
        (text, pad) => {
          expect(decideTurn(`${pad}${text}${pad}`)).toEqual(decideTurn(text));
        },
      ),
      settings,
    );
  });

  test("a trigger or binding environment is always kept", () => {
    fc.assert(
      fc.property(fc.constantFrom<"dev" | "prod">("dev", "prod"), (environment) => {
        expect(decideRunEnvironment({ kind: "resolved", environment })).toBe(environment);
      }),
      settings,
    );
  });

  test("the default runs in dev exactly when every connector binds in dev", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<"dev" | "prod" | null>("dev", "prod", null), { maxLength: 6 }),
        (dev_bindings) => {
          const decided = decideRunEnvironment({ kind: "default", dev_bindings });
          expect(decided).toBe(dev_bindings.every((bound) => bound === "dev") ? "dev" : null);
        },
      ),
      settings,
    );
  });

  test("a pending approval resumes exactly inside the window", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 * AFFIRM_RESUME_WINDOW_MS }), (age) => {
        const now = 1_700_000_000_000;
        const id = resumableApprovalId(
          {
            output: { pending: true },
            confirmation_data: { approval_id: "ap" },
            created_at: new Date(now - age),
          },
          now,
        );
        expect(id).toBe(age < AFFIRM_RESUME_WINDOW_MS ? "ap" : null);
      }),
      settings,
    );
  });

  test("a held preview is never ok and a failed run is never ok", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("succeeded", "failed", "cancelled"),
        fc.array(fc.constantFrom("held", "w1", "w2"), { maxLength: 4 }),
        (status, codes) => {
          const reply = runReply(
            "wf",
            "run wf",
            { status, output: null, steps: [], warnings: codes.map((code) => ({ code })) },
            "held",
          );
          expect(reply.held_preview).toBe(codes.includes("held"));
          expect(reply.ok).toBe(status === "succeeded" && !codes.includes("held"));
        },
      ),
      settings,
    );
  });

  test("a step line starts with the step key and ends with the duration when known", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 10 }),
        fc.option(fc.nat(), { nil: null }),
        (step_key, duration_ms) => {
          const line = stepLine({ step_key, kind: "k", status: "s", duration_ms });
          expect(line.startsWith(`- ${step_key} (k) s`)).toBe(true);
          expect(line.endsWith(duration_ms === null ? " s" : `${duration_ms}ms`)).toBe(true);
        },
      ),
      settings,
    );
  });
});
