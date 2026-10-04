import { describe, expect, test } from "bun:test";
import type { OperatorHealthDigest } from "../engine-client.ts";
import {
  buildStarterActions,
  buildStarterTaskActions,
  REVIEW_LEARNINGS_ACTION_ID,
  shouldInjectLearnings,
  shouldInjectTriage,
  TRIAGE_ACTION_ID,
} from "../repl/starter-action-injection.ts";
import { DEFAULT_STARTER_ACTIONS, starterActionsForPersona } from "../repl/starter-actions.tsx";
import { starterTaskActionsForPersona } from "../repl/task-actions.ts";
import type { PersonaProbe } from "../slash.ts";

const allowAll: PersonaProbe = { allows: () => true };
const denyAll: PersonaProbe = { allows: () => false };
const noWrite: PersonaProbe = { allows: (p) => p !== "conversation:write" };
const noSkillRead: PersonaProbe = { allows: (p) => p !== "skill:read" };

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
      scheduled_count: 0,
      last_seen: "2026-06-22T07:30:00Z",
      resolved_at: null,
      cause: "Something failed",
      guidance: null,
    })),
    patch_candidates: { open: 0, items: [] },
    risk: [],
    attention: { schema_version: "attention.v1", sources: {}, items: [] },
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

describe("shouldInjectLearnings — RBAC + count gate", () => {
  test("true when learnings are pending and the persona may read skills", () => {
    expect(shouldInjectLearnings(1, allowAll)).toBe(true);
    expect(shouldInjectLearnings(7, allowAll)).toBe(true);
  });

  test("false when the persona lacks skill:read", () => {
    expect(shouldInjectLearnings(3, denyAll)).toBe(false);
    expect(shouldInjectLearnings(3, noSkillRead)).toBe(false);
  });

  test("false when no learnings are pending", () => {
    expect(shouldInjectLearnings(0, allowAll)).toBe(false);
    expect(shouldInjectLearnings(-1, allowAll)).toBe(false);
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

describe("learnings injection — without triage", () => {
  test("learnings entry takes key '1' when there is no digest", () => {
    const actions = buildStarterActions("admin", allowAll, null, 2);
    expect(actions[0]?.key).toBe("1");
    expect(actions[0]?.actionId).toBe(REVIEW_LEARNINGS_ACTION_ID);
    expect(actions[0]?.label).toBe("Review 2 proposed learnings");
    expect(actions[0]?.detail).toBe("curation");
    expect(actions.slice(1).map((a) => a.key)).toEqual(["2", "3", "4", "5", "6"]);
  });

  test("label singularises when exactly one learning is pending", () => {
    const actions = buildStarterActions("admin", allowAll, null, 1);
    expect(actions[0]?.label).toBe("Review 1 proposed learning");
  });

  test("dispatch list mirrors the render list", () => {
    const actions = buildStarterTaskActions("admin", allowAll, null, 2);
    expect(actions[0]?.id).toBe(REVIEW_LEARNINGS_ACTION_ID);
    expect(actions[0]?.key).toBe("1");
    expect(actions[1]?.key).toBe("2");
  });

  test("not injected when pendingLearnings is 0 (explicit and default)", () => {
    expect(
      buildStarterActions("admin", allowAll, null, 0).find(
        (a) => a.actionId === REVIEW_LEARNINGS_ACTION_ID,
      ),
    ).toBeUndefined();
    expect(
      buildStarterActions("admin", allowAll, null).find(
        (a) => a.actionId === REVIEW_LEARNINGS_ACTION_ID,
      ),
    ).toBeUndefined();
  });

  test("not injected when the probe lacks skill:read", () => {
    const actions = buildStarterActions("admin", noSkillRead, null, 3);
    expect(actions.find((a) => a.actionId === REVIEW_LEARNINGS_ACTION_ID)).toBeUndefined();
    expect(actions).toEqual(starterActionsForPersona("admin", noSkillRead));
  });
});

describe("learnings injection — combined with triage", () => {
  test("triage keeps key '1', learnings takes '2', defaults renumber from '3'", () => {
    const rendered = buildStarterActions("admin", allowAll, makeDigest([3]), 2);
    expect(rendered[0]?.key).toBe("1");
    expect(rendered[0]?.actionId).toBe(TRIAGE_ACTION_ID);
    expect(rendered[1]?.key).toBe("2");
    expect(rendered[1]?.actionId).toBe(REVIEW_LEARNINGS_ACTION_ID);
    expect(rendered.slice(2).map((a) => a.key)).toEqual(["3", "4", "5", "6", "7"]);
    const keys = rendered.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("triage-only when the probe lacks skill:read", () => {
    const rendered = buildStarterActions("admin", noSkillRead, makeDigest([3]), 2);
    expect(rendered[0]?.actionId).toBe(TRIAGE_ACTION_ID);
    expect(rendered.find((a) => a.actionId === REVIEW_LEARNINGS_ACTION_ID)).toBeUndefined();
    expect(rendered.slice(1).map((a) => a.key)).toEqual(["2", "3", "4", "5", "6"]);
  });

  test("learnings-only at key '1' when the probe lacks conversation:write", () => {
    const rendered = buildStarterActions("admin", noWrite, makeDigest([3]), 1);
    expect(rendered[0]?.key).toBe("1");
    expect(rendered[0]?.actionId).toBe(REVIEW_LEARNINGS_ACTION_ID);
    expect(rendered.find((a) => a.actionId === TRIAGE_ACTION_ID)).toBeUndefined();
  });

  test("render ↔ dispatch key parity holds for every gate combination", () => {
    const digest = makeDigest([5]);
    const probes: Array<[string, PersonaProbe]> = [
      ["allowAll", allowAll],
      ["noWrite", noWrite],
      ["noSkillRead", noSkillRead],
      ["denyAll", denyAll],
    ];
    for (const [label, probe] of probes) {
      for (const learnings of [0, 1, 4]) {
        const rendered = buildStarterActions("admin", probe, digest, learnings);
        const dispatch = buildStarterTaskActions("admin", probe, digest, learnings);
        expect(
          rendered.map((a) => a.key),
          `probe=${label} learnings=${learnings}`,
        ).toEqual(dispatch.map((a) => a.key ?? ""));
      }
    }
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
