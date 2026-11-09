import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  type ActivateDraftFacts,
  decide,
  describeRejection,
  evolve,
  hatStatus,
  nextVersion,
  statusOf,
  WORKFLOW_COMMAND_TYPES,
  WORKFLOW_LIFECYCLES,
  WORKFLOW_TRANSITIONS,
  type WorkflowCommand,
  type WorkflowState,
} from "./workflow.ts";

const FC = { seed: 20261106, numRuns: 200 } as const;

const V1 = "00000000-0000-4000-8000-000000000001";
const V2 = "00000000-0000-4000-8000-000000000002";

const active: WorkflowState = { lifecycle: "active", current_version_id: V1, draft_version_id: V2 };
const draft: WorkflowState = { lifecycle: "draft", current_version_id: null, draft_version_id: V2 };
const archived: WorkflowState = {
  lifecycle: "archived",
  current_version_id: V1,
  draft_version_id: null,
};

const reviewed: ActivateDraftFacts = {
  manifestDigestMatches: true,
  expectedCurrentVersionId: V1,
  previousVersionIsNewer: false,
};

const idArb = fc.constantFrom(V1, V2, "00000000-0000-4000-8000-000000000003");
const stateArb: fc.Arbitrary<WorkflowState | null> = fc.option(
  fc.record({
    lifecycle: fc.constantFrom(...WORKFLOW_LIFECYCLES),
    current_version_id: fc.option(idArb, { nil: null }),
    draft_version_id: fc.option(idArb, { nil: null }),
  }),
  { nil: null },
);
const commandArb: fc.Arbitrary<WorkflowCommand> = fc.oneof(
  idArb.map((version_id) => ({ type: "CreateWorkflow" as const, version_id })),
  idArb.map((version_id) => ({ type: "SaveDraft" as const, version_id })),
  idArb.map((version_id) => ({ type: "ActivateDraft" as const, version_id })),
  fc.constant({ type: "ArchiveWorkflow" as const }),
  fc.constant({ type: "RestoreWorkflow" as const }),
  idArb.map((version_id) => ({ type: "RotateVersion" as const, version_id })),
  idArb.map((version_id) => ({ type: "RestoreVersion" as const, version_id })),
);
const factsArb: fc.Arbitrary<ActivateDraftFacts> = fc.record({
  manifestDigestMatches: fc.boolean(),
  expectedCurrentVersionId: fc.option(idArb, { nil: null }),
  previousVersionIsNewer: fc.boolean(),
});

describe("transition table", () => {
  test("names every command at least once", () => {
    const named = new Set(Object.values(WORKFLOW_TRANSITIONS).flat());
    expect([...named].sort()).toEqual([...WORKFLOW_COMMAND_TYPES].sort());
  });

  test("a draft never becomes active through RestoreWorkflow", () => {
    expect(hatStatus(draft, "RestoreWorkflow")).toBe(false);
    expect(hatStatus(archived, "RestoreWorkflow")).toBe(true);
  });

  test("statusOf maps a missing workflow to none", () => {
    expect(statusOf(null)).toBe("none");
    expect(statusOf(active)).toBe("active");
  });
});

describe("CreateWorkflow", () => {
  test("creates an active workflow with its first version current", () => {
    expect(decide(null, { type: "CreateWorkflow", version_id: V1 })).toEqual({
      ok: true,
      event: {
        type: "WorkflowCreated",
        lifecycle: "active",
        current_version_id: V1,
        draft_version_id: null,
      },
    });
  });

  test("is rejected for an existing workflow", () => {
    expect(decide(active, { type: "CreateWorkflow", version_id: V1 })).toEqual({
      ok: false,
      rejection: {
        code: "lifecycle_transition_not_allowed",
        from: "active",
        command: "CreateWorkflow",
      },
    });
  });
});

describe("SaveDraft", () => {
  test("creates a draft workflow when none exists", () => {
    expect(decide(null, { type: "SaveDraft", version_id: V2 })).toEqual({
      ok: true,
      event: {
        type: "WorkflowCreated",
        lifecycle: "draft",
        current_version_id: null,
        draft_version_id: V2,
      },
    });
  });

  test("moves the draft pointer in every lifecycle", () => {
    for (const state of [draft, active, archived]) {
      expect(decide(state, { type: "SaveDraft", version_id: V2 })).toEqual({
        ok: true,
        event: { type: "DraftSaved", draft_version_id: V2 },
      });
    }
  });
});

describe("ActivateDraft", () => {
  const command = { type: "ActivateDraft", version_id: V2 } as const;

  test("activates the reviewed draft", () => {
    expect(decide(active, command, reviewed)).toEqual({
      ok: true,
      event: { type: "DraftActivated", current_version_id: V2 },
    });
    expect(decide(draft, command, { ...reviewed, expectedCurrentVersionId: null }).ok).toBe(true);
  });

  test("an archived workflow is not activated", () => {
    expect(decide(archived, command, reviewed)).toEqual({
      ok: false,
      rejection: {
        code: "lifecycle_transition_not_allowed",
        from: "archived",
        command: "ActivateDraft",
      },
    });
  });

  test("rejects a draft that changed after the review", () => {
    expect(decide(active, { type: "ActivateDraft", version_id: V1 }, reviewed)).toEqual({
      ok: false,
      rejection: { code: "draft_changed" },
    });
  });

  test("rejects a current version that moved after the review", () => {
    expect(decide(active, command, { ...reviewed, expectedCurrentVersionId: null })).toEqual({
      ok: false,
      rejection: { code: "current_version_changed" },
    });
  });

  test("rejects a changed manifest", () => {
    expect(decide(active, command, { ...reviewed, manifestDigestMatches: false })).toEqual({
      ok: false,
      rejection: { code: "manifest_changed" },
    });
  });

  test("rejects when a newer version became active", () => {
    expect(decide(active, command, { ...reviewed, previousVersionIsNewer: true })).toEqual({
      ok: false,
      rejection: { code: "newer_version_active" },
    });
  });

  test("without facts nothing is activated", () => {
    expect(decide(draft, command as WorkflowCommand)).toEqual({
      ok: false,
      rejection: { code: "manifest_changed" },
    });
    expect(decide(active, command as WorkflowCommand)).toEqual({
      ok: false,
      rejection: { code: "current_version_changed" },
    });
  });
});

describe("ArchiveWorkflow and RestoreWorkflow", () => {
  test("archives a draft or an active workflow", () => {
    for (const state of [draft, active]) {
      expect(decide(state, { type: "ArchiveWorkflow" })).toEqual({
        ok: true,
        event: { type: "WorkflowArchived" },
      });
    }
  });

  test("restores an archived workflow that has a current version", () => {
    expect(decide(archived, { type: "RestoreWorkflow" })).toEqual({
      ok: true,
      event: { type: "WorkflowRestored" },
    });
  });

  test("an archived workflow without a current version stays archived", () => {
    expect(decide({ ...archived, current_version_id: null }, { type: "RestoreWorkflow" })).toEqual({
      ok: false,
      rejection: { code: "no_current_version" },
    });
  });

  test("draft to active through metadata is rejected", () => {
    expect(decide(draft, { type: "RestoreWorkflow" })).toEqual({
      ok: false,
      rejection: {
        code: "lifecycle_transition_not_allowed",
        from: "draft",
        command: "RestoreWorkflow",
      },
    });
  });
});

describe("RotateVersion and RestoreVersion", () => {
  test("move the current pointer in every existing lifecycle", () => {
    for (const state of [draft, active, archived]) {
      expect(decide(state, { type: "RotateVersion", version_id: V2 })).toEqual({
        ok: true,
        event: { type: "VersionRotated", current_version_id: V2 },
      });
      expect(decide(state, { type: "RestoreVersion", version_id: V2 })).toEqual({
        ok: true,
        event: { type: "VersionRestored", current_version_id: V2 },
      });
    }
  });

  test("need an existing workflow", () => {
    expect(decide(null, { type: "RotateVersion", version_id: V2 }).ok).toBe(false);
    expect(decide(null, { type: "RestoreVersion", version_id: V2 }).ok).toBe(false);
  });
});

describe("evolve", () => {
  test("applies each event to the pointers", () => {
    expect(
      evolve(null, {
        type: "WorkflowCreated",
        lifecycle: "active",
        current_version_id: V1,
        draft_version_id: null,
      }),
    ).toEqual({ lifecycle: "active", current_version_id: V1, draft_version_id: null });
    expect(evolve(active, { type: "DraftSaved", draft_version_id: V1 })).toEqual({
      ...active,
      draft_version_id: V1,
    });
    expect(evolve(draft, { type: "DraftActivated", current_version_id: V2 })).toEqual({
      lifecycle: "active",
      current_version_id: V2,
      draft_version_id: null,
    });
    expect(evolve(active, { type: "WorkflowArchived" }).lifecycle).toBe("archived");
    expect(evolve(archived, { type: "WorkflowRestored" }).lifecycle).toBe("active");
    expect(evolve(active, { type: "VersionRotated", current_version_id: V2 })).toEqual({
      ...active,
      current_version_id: V2,
    });
    expect(evolve(active, { type: "VersionRestored", current_version_id: V2 })).toEqual({
      ...active,
      current_version_id: V2,
    });
  });

  test("an event on a missing workflow starts from an empty draft", () => {
    expect(evolve(null, { type: "DraftSaved", draft_version_id: V2 })).toEqual({
      lifecycle: "draft",
      current_version_id: null,
      draft_version_id: V2,
    });
  });
});

describe("describeRejection", () => {
  test("names every rejection", () => {
    expect(
      describeRejection({
        code: "lifecycle_transition_not_allowed",
        from: "draft",
        command: "RestoreWorkflow",
      }),
    ).toBe("a draft workflow becomes active only through review and activation");
    expect(
      describeRejection({
        code: "lifecycle_transition_not_allowed",
        from: "none",
        command: "RotateVersion",
      }),
    ).toBe('a workflow in lifecycle "none" does not accept RotateVersion');
    expect(
      describeRejection({
        code: "lifecycle_transition_not_allowed",
        from: "archived",
        command: "ActivateDraft",
      }),
    ).toBe("this workflow is archived; restore it before activating a reviewed change");
    expect(
      describeRejection({
        code: "lifecycle_transition_not_allowed",
        from: "draft",
        command: "CreateWorkflow",
      }),
    ).toBe('a workflow in lifecycle "draft" does not accept CreateWorkflow');
    expect(
      describeRejection({
        code: "lifecycle_transition_not_allowed",
        from: "none",
        command: "RestoreWorkflow",
      }),
    ).toBe('a workflow in lifecycle "none" does not accept RestoreWorkflow');
    expect(
      describeRejection({
        code: "lifecycle_transition_not_allowed",
        from: "archived",
        command: "CreateWorkflow",
      }),
    ).toBe('a workflow in lifecycle "archived" does not accept CreateWorkflow');
    expect(
      describeRejection({
        code: "lifecycle_transition_not_allowed",
        from: "none",
        command: "ActivateDraft",
      }),
    ).toBe('a workflow in lifecycle "none" does not accept ActivateDraft');
    expect(describeRejection({ code: "no_current_version" })).toContain("no reviewed version");
    expect(describeRejection({ code: "manifest_changed" })).toBe(
      "the reviewed boundary changed; review again",
    );
    expect(describeRejection({ code: "newer_version_active" })).toContain("A newer version");
    expect(describeRejection({ code: "draft_changed" })).toBe(
      "The workflow changed; review the latest saved change again.",
    );
    expect(describeRejection({ code: "current_version_changed" })).toBe(
      "The workflow changed; review the latest saved change again.",
    );
  });
});

describe("nextVersion", () => {
  test("starts at 1 and follows the highest version", () => {
    expect(nextVersion([])).toBe(1);
    expect(nextVersion([0])).toBe(1);
    expect(nextVersion([3, 1, 2])).toBe(4);
  });
});

describe("properties", () => {
  test("decide never returns an event for a command outside the transition table", () => {
    fc.assert(
      fc.property(stateArb, commandArb, factsArb, (state, command, facts) => {
        const decision = decide(state, command, facts);
        if (decision.ok) expect(hatStatus(state, command.type)).toBe(true);
        if (!hatStatus(state, command.type)) expect(decision.ok).toBe(false);
      }),
      FC,
    );
  });

  test("an accepted event moves the lifecycle only along the table", () => {
    fc.assert(
      fc.property(stateArb, commandArb, factsArb, (state, command, facts) => {
        const decision = decide(state, command, facts);
        if (!decision.ok) return;
        const next = evolve(state, decision.event);
        if (next.lifecycle === "active" && state?.lifecycle === "draft")
          expect(command.type).toBe("ActivateDraft");
        if (next.lifecycle === "active" && state?.lifecycle === "archived")
          expect(command.type).toBe("RestoreWorkflow");
        if (next.lifecycle === "archived" && state?.lifecycle !== "archived")
          expect(command.type).toBe("ArchiveWorkflow");
      }),
      FC,
    );
  });

  test("decide does not change its arguments", () => {
    fc.assert(
      fc.property(stateArb, commandArb, factsArb, (state, command, facts) => {
        const before = JSON.stringify([state, command, facts]);
        decide(state, command, facts);
        expect(JSON.stringify([state, command, facts])).toBe(before);
      }),
      FC,
    );
  });

  test("nextVersion is strictly greater than every existing version", () => {
    fc.assert(
      fc.property(fc.array(fc.nat({ max: 1_000_000 })), (versions) => {
        const next = nextVersion(versions);
        for (const version of versions) expect(next).toBeGreaterThan(version);
      }),
      FC,
    );
  });

  test("nextVersion is monotonic as versions are appended", () => {
    fc.assert(
      fc.property(fc.array(fc.nat({ max: 1_000_000 })), fc.nat(), (versions, extra) => {
        const before = nextVersion(versions);
        const after = nextVersion([...versions, before]);
        expect(after).toBeGreaterThan(before);
        expect(nextVersion([...versions, extra])).toBeGreaterThanOrEqual(before);
      }),
      FC,
    );
  });
});

test("version allocation ignores non-increasing values, including NaN", () => {
  expect(nextVersion([NaN, -3, 0, 4, 4, 2])).toBe(5);
  expect(nextVersion([NaN, -Infinity])).toBe(1);
  expect(nextVersion([Infinity])).toBe(Infinity);
});
