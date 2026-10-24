import { describe, expect, test } from "bun:test";
import type { WorkflowSpec } from "../workflows/draft-schemas.ts";
import {
  authoredWorkflowSpec,
  draftGoal,
  reconcileDraftSpec,
  SPEC_GOAL_QUESTION,
  specQuestions,
} from "./authoring-spec.ts";
import { normalizeDraftDocument } from "./authoring-state.ts";
import type { WorkflowDraftDocument } from "./types.ts";

function spec(goal: string | null, origin: WorkflowSpec["origin"] = "chat"): WorkflowSpec {
  return {
    goal,
    inputs: [],
    outputs: [{ name: "summary" }],
    delivery: null,
    conventions_applied: [],
    evidence: [],
    open_questions: [],
    origin,
  };
}

function draft(extra: Partial<WorkflowDraftDocument> = {}): WorkflowDraftDocument {
  return { name: "w", slug: "w", steps: [], ...extra };
}

describe("the conversation draft keeps its spec", () => {
  test("a spec survives draft normalization", () => {
    const normalized = normalizeDraftDocument({
      workflow: { name: "w", slug: "w", steps: [], spec: spec("Report visits") },
    });
    expect(normalized.workflow.spec).toEqual(spec("Report visits"));
  });

  test("an invalid spec is dropped during normalization", () => {
    const normalized = normalizeDraftDocument({
      workflow: { name: "w", slug: "w", steps: [], spec: { goal: 1 } },
    });
    expect(normalized.workflow.spec).toBeUndefined();
  });
});

describe("reconcileDraftSpec", () => {
  test("a goal stated in the conversation creates a chat spec", () => {
    const next = reconcileDraftSpec(draft(), draft({ goal: "Count visits" }));
    expect(next.spec).toMatchObject({ goal: "Count visits", origin: "chat" });
  });

  test("a changed person spec becomes a chat spec", () => {
    const prior = draft({ spec: spec("Count visits", "person") });
    const next = reconcileDraftSpec(prior, draft({ spec: spec("Count all visits", "person") }));
    expect(next.spec?.origin).toBe("chat");
  });

  test("an unchanged person spec stays a person spec", () => {
    const prior = draft({ spec: spec("Count visits", "person") });
    const next = reconcileDraftSpec(
      prior,
      draft({ spec: spec("Count visits", "person"), steps: [] }),
    );
    expect(next.spec?.origin).toBe("person");
  });

  test("a chat cannot raise a spec to person origin", () => {
    const prior = draft({ spec: spec("Count visits") });
    const next = reconcileDraftSpec(prior, draft({ spec: spec("Count visits", "person") }));
    expect(next.spec?.origin).toBe("chat");
  });

  test("a new conversation goal replaces the spec goal", () => {
    const prior = draft({ goal: "Count visits", spec: spec("Count visits") });
    const next = reconcileDraftSpec(
      prior,
      draft({ goal: "Count visits per day", spec: spec("Count visits") }),
    );
    expect(next.spec?.goal).toBe("Count visits per day");
  });

  test("an edited spec goal updates the conversation goal", () => {
    const prior = draft({ goal: "Count visits", spec: spec("Count visits") });
    const next = reconcileDraftSpec(
      prior,
      draft({ goal: "Count visits", spec: spec("Count clicks") }),
    );
    expect(next.goal).toBe("Count clicks");
  });

  test("an unchanged draft is returned as is", () => {
    const value = draft({ goal: "Count visits", spec: spec("Count visits") });
    expect(reconcileDraftSpec(value, value)).toBe(value);
  });
});

describe("draftGoal", () => {
  test("a goal stated in this conversation counts as confirmed", () => {
    expect(draftGoal(draft({ goal: "Count visits" }))).toEqual({
      goal: "Count visits",
      source: "conversation",
      confirmed: true,
    });
  });

  test("a stored chat goal is used but unconfirmed", () => {
    expect(draftGoal(draft({ spec: spec("Count visits") }))).toEqual({
      goal: "Count visits",
      source: "spec",
      confirmed: false,
    });
  });

  test("a stored person goal is confirmed", () => {
    expect(draftGoal(draft({ spec: spec("Count visits", "person") })).confirmed).toBe(true);
  });
});

describe("authoredWorkflowSpec", () => {
  test("a long goal is capped to the spec limit", () => {
    const authored = authoredWorkflowSpec({ prior: null, goal: "x".repeat(2500), definition: {} });
    expect(authored.goal?.length).toBe(2000);
  });
});

describe("specQuestions", () => {
  test("a draft without a goal asks for it", () => {
    expect(specQuestions(draft())?.questions).toEqual([SPEC_GOAL_QUESTION]);
  });

  test("open spec questions are asked with the existing form tool", () => {
    const value = draft({
      spec: { ...spec("Count visits"), open_questions: ["Which time zone?"] },
    });
    const questions = specQuestions(value);
    expect(questions?.questions).toEqual(["Which time zone?"]);
    expect(questions?.user_prompt.tool).toBe("ask_user_form");
  });

  test("a complete spec asks nothing", () => {
    expect(specQuestions(draft({ spec: spec("Count visits") }))).toBeNull();
  });
});
