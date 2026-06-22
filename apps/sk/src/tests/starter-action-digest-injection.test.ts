// Tests for the digest-driven starter-action injection logic.
//
// When a digest with failures is present the REPL prepends a "guided triage"
// entry keyed "1" and renumbers the persona defaults starting at "2". When
// there is no digest (or the digest has no failures) the defaults are left
// unchanged. The injection logic in ink-app.tsx uses the same building-block
// functions tested here; this file validates the pieces that can be exercised
// without mounting the full Ink tree.

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_STARTER_ACTIONS,
  type StarterAction,
  starterActionsForPersona,
} from "../repl/starter-actions.tsx";
import {
  findTaskActionById,
  starterTaskActionsForPersona,
  type TaskAction,
} from "../repl/task-actions.ts";
import type { PersonaProbe } from "../slash.ts";

// Replicates the useMemo logic from ink-app.tsx so we can test
// the injection contract without React or Ink.
function buildStarterActionsWithDigest(opts: {
  personaLabel: string;
  probe?: PersonaProbe;
  digestFailCount: number;
  injectTriage: boolean;
}): readonly StarterAction[] {
  const base = starterActionsForPersona(opts.personaLabel);
  if (!opts.injectTriage) return base;
  const triage: StarterAction = {
    key: "1",
    label: `Fix ${opts.digestFailCount} failure${opts.digestFailCount === 1 ? "" : "s"}`,
    detail: "guided triage",
    actionId: "triage-digest-failures",
  };
  const renumbered = base.map((action, i) => ({ ...action, key: String(Math.min(i + 2, 9)) }));
  return [triage, ...renumbered];
}

function buildStarterTaskActionsWithDigest(opts: {
  personaLabel: string;
  probe: PersonaProbe;
  injectTriage: boolean;
}): readonly TaskAction[] {
  const base = starterTaskActionsForPersona(opts.personaLabel, opts.probe);
  if (!opts.injectTriage) return base;
  const triageAction = findTaskActionById("triage-digest-failures");
  if (!triageAction) return base;
  const renumbered = base.map((action, i) => ({ ...action, key: String(Math.min(i + 2, 9)) }));
  return [{ ...triageAction, key: "1" }, ...renumbered];
}

const allowAll: PersonaProbe = { allows: () => true };

describe("starter-action injection — digest with failures", () => {
  test("triage entry is at key '1' when digest has failures", () => {
    const actions = buildStarterActionsWithDigest({
      personaLabel: "admin",
      injectTriage: true,
      digestFailCount: 3,
    });
    expect(actions[0]?.key).toBe("1");
    expect(actions[0]?.actionId).toBe("triage-digest-failures");
  });

  test("label includes the failure count (plural)", () => {
    const actions = buildStarterActionsWithDigest({
      personaLabel: "admin",
      injectTriage: true,
      digestFailCount: 3,
    });
    expect(actions[0]?.label).toBe("Fix 3 failures");
  });

  test("label singularises when count === 1", () => {
    const actions = buildStarterActionsWithDigest({
      personaLabel: "admin",
      injectTriage: true,
      digestFailCount: 1,
    });
    expect(actions[0]?.label).toBe("Fix 1 failure");
  });

  test("detail is 'guided triage'", () => {
    const actions = buildStarterActionsWithDigest({
      personaLabel: "admin",
      injectTriage: true,
      digestFailCount: 2,
    });
    expect(actions[0]?.detail).toBe("guided triage");
  });

  test("default actions are renumbered starting at '2'", () => {
    const actions = buildStarterActionsWithDigest({
      personaLabel: "admin",
      injectTriage: true,
      digestFailCount: 4,
    });
    // Triage occupies key "1"; the 5 defaults become keys "2"–"6"
    expect(actions.length).toBe(6);
    expect(actions[1]?.key).toBe("2");
    expect(actions[2]?.key).toBe("3");
    expect(actions[3]?.key).toBe("4");
    expect(actions[4]?.key).toBe("5");
    expect(actions[5]?.key).toBe("6");
  });

  test("task-action variant: triage action key is '1'", () => {
    const actions = buildStarterTaskActionsWithDigest({
      personaLabel: "admin",
      probe: allowAll,
      injectTriage: true,
    });
    expect(actions[0]?.id).toBe("triage-digest-failures");
    expect(actions[0]?.key).toBe("1");
  });

  test("task-action variant: remaining defaults renumbered from '2'", () => {
    const actions = buildStarterTaskActionsWithDigest({
      personaLabel: "admin",
      probe: allowAll,
      injectTriage: true,
    });
    expect(actions.length).toBeGreaterThan(1);
    expect(actions[1]?.key).toBe("2");
  });
});

describe("starter-action injection — no digest", () => {
  test("defaults are unchanged when injectTriage is false", () => {
    const actions = buildStarterActionsWithDigest({
      personaLabel: "admin",
      injectTriage: false,
      digestFailCount: 0,
    });
    expect(actions).toEqual(DEFAULT_STARTER_ACTIONS);
  });

  test("first action is NOT triage when there is no digest", () => {
    const actions = buildStarterActionsWithDigest({
      personaLabel: "admin",
      injectTriage: false,
      digestFailCount: 0,
    });
    expect(actions[0]?.actionId).not.toBe("triage-digest-failures");
  });

  test("first action key is still '1' (resume-recent) without a digest", () => {
    const actions = buildStarterActionsWithDigest({
      personaLabel: "admin",
      injectTriage: false,
      digestFailCount: 0,
    });
    expect(actions[0]?.key).toBe("1");
    expect(actions[0]?.actionId).toBe("resume-recent");
  });

  test("task-action variant: defaults unchanged when injectTriage is false", () => {
    const actions = buildStarterTaskActionsWithDigest({
      personaLabel: "admin",
      probe: allowAll,
      injectTriage: false,
    });
    const baseline = starterTaskActionsForPersona("admin", allowAll);
    expect(actions.map((a) => a.id)).toEqual(baseline.map((a) => a.id));
  });
});
