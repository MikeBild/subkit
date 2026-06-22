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
// Allows everything except conversation:write — enough to read the digest, not
// enough to run the triage action.
const noWrite: PersonaProbe = { allows: (p) => p !== "conversation:write" };

function makeDigest(counts: number[] = [3]): OperatorHealthDigest {
  return {
    generated_at: "2026-06-22T08:00:00Z",
    window_hours: 24,
    headline: "failures in the last 24h",
    failure_groups: counts.map((count, i) => ({
      signature: `sig-${i}`,
      workflow_id: `wf-${i}`,
      workflow_name: `Workflow ${i}`,
      step_key: "step",
      error_code: "ERR",
      origin: "manual" as const,
      count,
      last_seen: "2026-06-22T07:30:00Z",
      cause: "Something failed",
      guidance: null,
    })),
    patch_candidates: { pending: 0, items: [] },
    risk: [],
    rendered: "",
    all_clear: false,
  };
}
const noFailures = (): OperatorHealthDigest => ({ ...makeDigest([]), failure_groups: [] });

describe("shouldInjectTriage — RBAC + failure gate", () => {
  test("true when the digest has failures and the persona may act", () => {
    expect(shouldInjectTriage(makeDigest(), allowAll)).toBe(true);
  });

  test("false when the persona lacks conversation:write", () => {
    expect(shouldInjectTriage(makeDigest(), denyAll)).toBe(false);
    expect(shouldInjectTriage(makeDigest(), noWrite)).toBe(false);
  });

  test("false when the digest has no failures", () => {
    expect(shouldInjectTriage(noFailures(), allowAll)).toBe(false);
  });

  test("false when there is no digest", () => {
    expect(shouldInjectTriage(null, allowAll)).toBe(false);
    expect(shouldInjectTriage(undefined, allowAll)).toBe(false);
  });
});

describe("buildStarterActions — injected", () => {
  test("triage entry is at key '1' with the triage actionId", () => {
    const actions = buildStarterActions("admin", allowAll, makeDigest([3]));
    expect(actions[0]?.key).toBe("1");
    expect(actions[0]?.actionId).toBe(TRIAGE_ACTION_ID);
  });

  test("label sums the failure counts (plural)", () => {
    const actions = buildStarterActions("admin", allowAll, makeDigest([2, 1]));
    expect(actions[0]?.label).toBe("Fix 3 failures");
  });

  test("label singularises when the total is 1", () => {
    const actions = buildStarterActions("admin", allowAll, makeDigest([1]));
    expect(actions[0]?.label).toBe("Fix 1 failure");
  });

  test("detail is 'guided triage'", () => {
    const actions = buildStarterActions("admin", allowAll, makeDigest([2]));
    expect(actions[0]?.detail).toBe("guided triage");
  });

  test("defaults are renumbered from '2' with no key collision", () => {
    const actions = buildStarterActions("admin", allowAll, makeDigest([4]));
    expect(actions.length).toBe(6);
    expect(actions.slice(1).map((a) => a.key)).toEqual(["2", "3", "4", "5", "6"]);
    const keys = actions.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("buildStarterTaskActions — injected", () => {
  test("triage action key is '1', defaults renumbered from '2'", () => {
    const actions = buildStarterTaskActions("admin", allowAll, makeDigest([3]));
    expect(actions[0]?.id).toBe(TRIAGE_ACTION_ID);
    expect(actions[0]?.key).toBe("1");
    expect(actions[1]?.key).toBe("2");
  });
});

describe("render ↔ dispatch parity", () => {
  test("rendered list and dispatch list have identical keys for the same inputs", () => {
    const digest = makeDigest([5]);
    const rendered = buildStarterActions("admin", allowAll, digest);
    const dispatch = buildStarterTaskActions("admin", allowAll, digest);
    expect(rendered.map((a) => a.key)).toEqual(dispatch.map((a) => a.key ?? ""));
  });

  test("a probe that hides a default hides it from BOTH lists (no drift)", () => {
    // conversation:write gates several defaults; denying it shrinks both lists
    // equally so a rendered number key always maps to a dispatchable action.
    const rendered = buildStarterActions("admin", noWrite, makeDigest([3]));
    const dispatch = buildStarterTaskActions("admin", noWrite, makeDigest([3]));
    expect(rendered.length).toBe(dispatch.length);
    expect(rendered.map((a) => a.key)).toEqual(dispatch.map((a) => a.key ?? ""));
  });
});

describe("starter-action injection — not injected", () => {
  test("no triage for a deny-all persona even with failures", () => {
    const actions = buildStarterActions("admin", denyAll, makeDigest([3]));
    expect(actions.find((a) => a.actionId === TRIAGE_ACTION_ID)).toBeUndefined();
  });

  test("no triage when the digest has no failures", () => {
    const actions = buildStarterActions("admin", allowAll, noFailures());
    expect(actions.find((a) => a.actionId === TRIAGE_ACTION_ID)).toBeUndefined();
  });

  test("render defaults equal the persona starter actions when not injected", () => {
    const actions = buildStarterActions("admin", allowAll, null);
    expect(actions).toEqual(starterActionsForPersona("admin", allowAll));
  });

  test("admin + allowAll + no digest matches DEFAULT_STARTER_ACTIONS", () => {
    const actions = buildStarterActions("admin", allowAll, null);
    expect(actions).toEqual(DEFAULT_STARTER_ACTIONS);
  });

  test("first action is still '1' (resume-recent) without injection", () => {
    const actions = buildStarterActions("admin", allowAll, null);
    expect(actions[0]?.key).toBe("1");
    expect(actions[0]?.actionId).toBe("resume-recent");
  });

  test("dispatch defaults unchanged when not injected", () => {
    const actions = buildStarterTaskActions("admin", allowAll, null);
    const baseline = starterTaskActionsForPersona("admin", allowAll);
    expect(actions.map((a) => a.id)).toEqual(baseline.map((a) => a.id));
  });
});
