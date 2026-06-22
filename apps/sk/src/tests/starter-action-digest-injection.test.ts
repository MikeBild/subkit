// Tests for the digest-driven starter-action injection logic.
//
// When a digest with failures is present AND the persona may run the triage
// action, the REPL prepends a "guided triage" entry keyed "1" and renumbers the
// persona defaults starting at "2". When there is no digest, the digest has no
// failures, or the persona lacks the required permission, the defaults are left
// unchanged. These tests exercise the REAL building blocks from
// repl/starter-action-injection.ts (the same functions ink-app.tsx calls), so
// the rendered list, the dispatch list, and the RBAC gate cannot drift.

import { describe, expect, test } from "bun:test";
import type { OperatorHealthDigest } from "../engine-client.ts";
import {
  buildStarterActions,
  buildStarterTaskActions,
  shouldInjectTriage,
  TRIAGE_ACTION_ID,
} from "../repl/starter-action-injection.ts";
import { DEFAULT_STARTER_ACTIONS, starterActionsForPersona } from "../repl/starter-actions.tsx";
import { starterTaskActionsForPersona } from "../repl/task-actions.ts";
import type { PersonaProbe } from "../slash.ts";

const allowAll: PersonaProbe = { allows: () => true };
const denyAll: PersonaProbe = { allows: () => false };

function makeDigest(overrides: Partial<OperatorHealthDigest> = {}): OperatorHealthDigest {
  return {
    generated_at: "2026-06-22T08:00:00Z",
    window_hours: 24,
    headline: "failures in the last 24h",
    failure_groups: [
      {
        signature: "sig",
        workflow_id: "wf",
        workflow_name: "Some workflow",
        step_key: "step",
        error_code: "ERR",
        origin: "manual",
        count: 3,
        last_seen: "2026-06-22T07:30:00Z",
        cause: "Something failed",
        guidance: null,
      },
    ],
    patch_candidates: { pending: 0, items: [] },
    risk: [],
    rendered: "",
    all_clear: false,
    ...overrides,
  };
}

describe("shouldInjectTriage — RBAC + failure gate", () => {
  test("true when the digest has failures and the persona may act", () => {
    expect(shouldInjectTriage(makeDigest(), allowAll)).toBe(true);
  });

  test("false when the persona lacks the required permission", () => {
    // The triage action requires conversation:write; a read-only persona must
    // not be offered a starter action the engine will then reject.
    expect(shouldInjectTriage(makeDigest(), denyAll)).toBe(false);
  });

  test("false when the digest has no failures", () => {
    expect(shouldInjectTriage(makeDigest({ failure_groups: [] }), allowAll)).toBe(false);
  });

  test("false when there is no digest", () => {
    expect(shouldInjectTriage(null, allowAll)).toBe(false);
    expect(shouldInjectTriage(undefined, allowAll)).toBe(false);
  });
});

describe("buildStarterActions — digest with failures", () => {
  test("triage entry is at key '1' with the triage actionId", () => {
    const actions = buildStarterActions("admin", { injectTriage: true, digestFailCount: 3 });
    expect(actions[0]?.key).toBe("1");
    expect(actions[0]?.actionId).toBe(TRIAGE_ACTION_ID);
  });

  test("label includes the failure count (plural)", () => {
    const actions = buildStarterActions("admin", { injectTriage: true, digestFailCount: 3 });
    expect(actions[0]?.label).toBe("Fix 3 failures");
  });

  test("label singularises when count === 1", () => {
    const actions = buildStarterActions("admin", { injectTriage: true, digestFailCount: 1 });
    expect(actions[0]?.label).toBe("Fix 1 failure");
  });

  test("detail is 'guided triage'", () => {
    const actions = buildStarterActions("admin", { injectTriage: true, digestFailCount: 2 });
    expect(actions[0]?.detail).toBe("guided triage");
  });

  test("default actions are renumbered starting at '2' with no key collision", () => {
    const actions = buildStarterActions("admin", { injectTriage: true, digestFailCount: 4 });
    // Triage occupies key "1"; the 5 defaults become keys "2"–"6".
    expect(actions.length).toBe(6);
    expect(actions.slice(1).map((a) => a.key)).toEqual(["2", "3", "4", "5", "6"]);
    // No two actions share a key (the latent Math.min clamp foot-gun is gone).
    const keys = actions.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("buildStarterTaskActions — digest with failures", () => {
  test("triage action key is '1'", () => {
    const actions = buildStarterTaskActions("admin", allowAll, { injectTriage: true });
    expect(actions[0]?.id).toBe(TRIAGE_ACTION_ID);
    expect(actions[0]?.key).toBe("1");
  });

  test("remaining defaults renumbered from '2'", () => {
    const actions = buildStarterTaskActions("admin", allowAll, { injectTriage: true });
    expect(actions.length).toBeGreaterThan(1);
    expect(actions[1]?.key).toBe("2");
  });
});

describe("starter-action injection — not injected", () => {
  test("render defaults are unchanged when injectTriage is false", () => {
    const actions = buildStarterActions("admin", { injectTriage: false, digestFailCount: 0 });
    expect(actions).toEqual(DEFAULT_STARTER_ACTIONS);
  });

  test("render first action is still '1' (resume-recent) without injection", () => {
    const actions = buildStarterActions("admin", { injectTriage: false, digestFailCount: 0 });
    expect(actions[0]?.key).toBe("1");
    expect(actions[0]?.actionId).toBe("resume-recent");
  });

  test("render first action is NOT triage without injection", () => {
    const actions = buildStarterActions("admin", { injectTriage: false, digestFailCount: 0 });
    expect(actions[0]?.actionId).not.toBe(TRIAGE_ACTION_ID);
  });

  test("dispatch defaults unchanged when injectTriage is false", () => {
    const actions = buildStarterTaskActions("admin", allowAll, { injectTriage: false });
    const baseline = starterTaskActionsForPersona("admin", allowAll);
    expect(actions.map((a) => a.id)).toEqual(baseline.map((a) => a.id));
  });

  test("render base matches the persona starter actions when not injected", () => {
    const actions = buildStarterActions("enduser", { injectTriage: false, digestFailCount: 0 });
    expect(actions).toEqual(starterActionsForPersona("enduser"));
  });
});
