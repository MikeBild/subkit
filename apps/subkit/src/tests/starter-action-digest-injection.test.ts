import { describe, expect, test } from "bun:test";
import type { OperatorHealthDigest } from "../engine-client.ts";
import {
  buildStarterActions,
  buildStarterTaskActions,
  REVIEW_INTAKE_ACTION_ID,
  shouldInjectIntakeReview,
  shouldInjectTriage,
  TRIAGE_ACTION_ID,
} from "../repl/starter-action-injection.ts";
import { DEFAULT_STARTER_ACTIONS, starterActionsForPersona } from "../repl/starter-actions.tsx";
import { starterTaskActionsForPersona } from "../repl/task-actions.ts";
import type { PersonaProbe } from "../slash.ts";
import { failureGroup, operatorDigest } from "./_helpers/operator-digest-fixtures.ts";

const allowAll: PersonaProbe = { allows: () => true };
const denyAll: PersonaProbe = { allows: () => false };
const noWrite: PersonaProbe = { allows: (p) => p !== "conversation:write" };
const noIntakeRead: PersonaProbe = { allows: (p) => p !== "intake:read" };
const pending = (count: number, category = "Inbox") => ({ category, count });

function makeDigest(counts: number[] = [3]): OperatorHealthDigest {
  return operatorDigest({
    headline: "failures in the last 24h",
    failure_groups: counts.map((count, i) =>
      failureGroup({
        signature: `sig-${i}`,
        workflow_id: `wf-${i}`,
        workflow_name: `Workflow ${i}`,
        count,
      }),
    ),
  });
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

describe("shouldInjectIntakeReview — RBAC + count gate", () => {
  test("true when collected items wait and the persona may read intake", () => {
    expect(shouldInjectIntakeReview(pending(1), allowAll)).toBe(true);
    expect(shouldInjectIntakeReview(pending(7), allowAll)).toBe(true);
  });

  test("false when the persona lacks intake:read or cannot start a chat turn", () => {
    expect(shouldInjectIntakeReview(pending(3), denyAll)).toBe(false);
    expect(shouldInjectIntakeReview(pending(3), noIntakeRead)).toBe(false);
    expect(shouldInjectIntakeReview(pending(3), noWrite)).toBe(false);
  });

  test("false when nothing is collected or the default category is unknown", () => {
    expect(shouldInjectIntakeReview(pending(0), allowAll)).toBe(false);
    expect(shouldInjectIntakeReview(null, allowAll)).toBe(false);
    expect(shouldInjectIntakeReview(undefined, allowAll)).toBe(false);
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

describe("intake review injection — without triage", () => {
  test("review entry takes key '1' and names the person's category", () => {
    const actions = buildStarterActions("admin", allowAll, null, pending(2, "Research"));
    expect(actions[0]?.key).toBe("1");
    expect(actions[0]?.actionId).toBe(REVIEW_INTAKE_ACTION_ID);
    expect(actions[0]?.label).toBe("Review 2 collected items in “Research”");
    expect(actions[0]?.detail).toBe("intake review");
    expect(actions.slice(1).map((a) => a.key)).toEqual(["2", "3", "4", "5", "6"]);
  });

  test("label singularises when exactly one item is collected", () => {
    const actions = buildStarterActions("admin", allowAll, null, pending(1));
    expect(actions[0]?.label).toBe("Review 1 collected item in “Inbox”");
  });

  test("label never claims the items are proposed or already knowledge", () => {
    const label = buildStarterActions("admin", allowAll, null, pending(3))[0]?.label ?? "";
    expect(label).not.toMatch(/proposed|learning|knowledge/i);
  });

  test("dispatch submits the review prompt in German when the language is German", () => {
    const previous = process.env.SUBKIT_LANG;
    process.env.SUBKIT_LANG = "de";
    try {
      const actions = buildStarterTaskActions("admin", allowAll, null, pending(2, "Research"));
      expect(actions[0]?.invoke).toEqual({
        kind: "prompt",
        prompt:
          "Schau meine neuen Einträge in „Research“ durch. Welche davon helfen uns? Schlage vor, was wir übernehmen sollten, als Wissen oder als Skill, mit genauem Text, Quellen und Ziel zur Bestätigung.",
      });
    } finally {
      if (previous === undefined) delete process.env.SUBKIT_LANG;
      else process.env.SUBKIT_LANG = previous;
    }
  });

  test("dispatch submits the category-aware review prompt", () => {
    const previous = process.env.SUBKIT_LANG;
    process.env.SUBKIT_LANG = "en";
    try {
      const actions = buildStarterTaskActions("admin", allowAll, null, pending(2, "Research"));
      expect(actions[0]?.id).toBe(REVIEW_INTAKE_ACTION_ID);
      expect(actions[0]?.key).toBe("1");
      expect(actions[0]?.requires).toBe("intake:read");
      expect(actions[0]?.invoke).toEqual({
        kind: "prompt",
        prompt:
          "Review my new items in “Research”. Which ones help us? Suggest what we should retain, as knowledge or as a skill, with the exact text, sources and destination for my confirmation.",
      });
      expect(actions[1]?.key).toBe("2");
    } finally {
      if (previous === undefined) delete process.env.SUBKIT_LANG;
      else process.env.SUBKIT_LANG = previous;
    }
  });

  test("terminal control sequences in the category name never reach label or prompt", () => {
    const hostile = pending(1, "In\u001b[31mbox\u0007");
    const [action] = buildStarterTaskActions("admin", allowAll, null, hostile);
    expect(action?.label).not.toContain("\u001b");
    expect(action?.invoke.kind === "prompt" ? action.invoke.prompt : "").not.toContain("\u001b");
  });

  test("not injected when nothing is collected (explicit and default)", () => {
    expect(
      buildStarterActions("admin", allowAll, null, pending(0)).find(
        (a) => a.actionId === REVIEW_INTAKE_ACTION_ID,
      ),
    ).toBeUndefined();
    expect(
      buildStarterActions("admin", allowAll, null).find(
        (a) => a.actionId === REVIEW_INTAKE_ACTION_ID,
      ),
    ).toBeUndefined();
  });

  test("not injected when the probe lacks intake:read", () => {
    const actions = buildStarterActions("admin", noIntakeRead, null, pending(3));
    expect(actions.find((a) => a.actionId === REVIEW_INTAKE_ACTION_ID)).toBeUndefined();
    expect(actions).toEqual(starterActionsForPersona("admin", noIntakeRead));
  });
});

describe("intake review injection — combined with triage", () => {
  test("triage keeps key '1', review takes '2', defaults renumber from '3'", () => {
    const rendered = buildStarterActions("admin", allowAll, makeDigest([3]), pending(2));
    expect(rendered[0]?.key).toBe("1");
    expect(rendered[0]?.actionId).toBe(TRIAGE_ACTION_ID);
    expect(rendered[1]?.key).toBe("2");
    expect(rendered[1]?.actionId).toBe(REVIEW_INTAKE_ACTION_ID);
    expect(rendered.slice(2).map((a) => a.key)).toEqual(["3", "4", "5", "6", "7"]);
    const keys = rendered.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("triage-only when the probe lacks intake:read", () => {
    const rendered = buildStarterActions("admin", noIntakeRead, makeDigest([3]), pending(2));
    expect(rendered[0]?.actionId).toBe(TRIAGE_ACTION_ID);
    expect(rendered.find((a) => a.actionId === REVIEW_INTAKE_ACTION_ID)).toBeUndefined();
    expect(rendered.slice(1).map((a) => a.key)).toEqual(["2", "3", "4", "5", "6"]);
  });

  test("neither triage nor review when the probe lacks conversation:write", () => {
    const rendered = buildStarterActions("admin", noWrite, makeDigest([3]), pending(1));
    expect(rendered.find((a) => a.actionId === REVIEW_INTAKE_ACTION_ID)).toBeUndefined();
    expect(rendered.find((a) => a.actionId === TRIAGE_ACTION_ID)).toBeUndefined();
  });

  test("render ↔ dispatch key parity holds for every gate combination", () => {
    const digest = makeDigest([5]);
    const probes: Array<[string, PersonaProbe]> = [
      ["allowAll", allowAll],
      ["noWrite", noWrite],
      ["noIntakeRead", noIntakeRead],
      ["denyAll", denyAll],
    ];
    for (const [label, probe] of probes) {
      for (const count of [0, 1, 4]) {
        const rendered = buildStarterActions("admin", probe, digest, pending(count));
        const dispatch = buildStarterTaskActions("admin", probe, digest, pending(count));
        expect(
          rendered.map((a) => a.key),
          `probe=${label} collected=${count}`,
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
