import { describe, expect, test } from "bun:test";
import type { DraftDocument } from "../types.ts";
import {
  abstentionRequest,
  commitAbstains,
  elicitationActorType,
  failedChecks,
  PROSE_TAIL_WINDOW,
  reviewArtifact,
  savedInertDraft,
  scanProseChunk,
  topSkillsByTokens,
  turnOutcome,
  validatedStepCount,
  workflowTriggerKind,
} from "./loop.ts";

function draftWith(partial: Record<string, unknown>): DraftDocument {
  return { workflow: { steps: [] }, ...partial } as unknown as DraftDocument;
}

const EMPTY_SCAN = { tail: "", scanFrom: 0, paragraphs: 0 };

describe("prose scanner", () => {
  test("text without a paragraph break only grows the tail", () => {
    expect(scanProseChunk(EMPTY_SCAN, "hello")).toStrictEqual({
      scan: { tail: "hello", scanFrom: 0, paragraphs: 0 },
      progressLabel: null,
      paragraph: null,
    });
  });

  test("a break emits the text before it and moves the scan past it", () => {
    const first = scanProseChunk(EMPTY_SCAN, "one\n  \ntwo");
    expect(first).toStrictEqual({
      scan: { tail: "one\n  \ntwo", scanFrom: 7, paragraphs: 1 },
      progressLabel: null,
      paragraph: "one",
    });
    const second = scanProseChunk(first.scan, "\n\nthree");
    expect(second).toStrictEqual({
      scan: { tail: "one\n  \ntwo\n\nthree", scanFrom: 12, paragraphs: 2 },
      progressLabel: "composing reply · 2 paragraphs so far",
      paragraph: "one\n  \ntwo",
    });
  });

  test("a break at the start yields no paragraph text", () => {
    expect(scanProseChunk(EMPTY_SCAN, "\n\nx")).toStrictEqual({
      scan: { tail: "\n\nx", scanFrom: 2, paragraphs: 1 },
      progressLabel: null,
      paragraph: null,
    });
  });

  test("a single newline or a break before the scan position is not a new paragraph", () => {
    expect(scanProseChunk(EMPTY_SCAN, "a\nb").paragraph).toBeNull();
    expect(scanProseChunk(EMPTY_SCAN, "a\n x\nb").paragraph).toBeNull();
    expect(scanProseChunk({ tail: "a\n\nb", scanFrom: 3, paragraphs: 1 }, "c")).toStrictEqual({
      scan: { tail: "a\n\nbc", scanFrom: 3, paragraphs: 1 },
      progressLabel: null,
      paragraph: null,
    });
  });

  test("the tail keeps a fixed window and shifts the scan position with it", () => {
    const tail = "x".repeat(PROSE_TAIL_WINDOW);
    expect(scanProseChunk({ tail, scanFrom: 100, paragraphs: 0 }, "yy").scan).toStrictEqual({
      tail: `${"x".repeat(PROSE_TAIL_WINDOW - 2)}yy`,
      scanFrom: 98,
      paragraphs: 0,
    });
    expect(scanProseChunk({ tail, scanFrom: 1, paragraphs: 0 }, "yy").scan.scanFrom).toBe(0);
    expect(PROSE_TAIL_WINDOW).toBe(4096);
  });
});

describe("top skills by tokens", () => {
  test("is null without skills", () => {
    expect(topSkillsByTokens([], 10, () => 1)).toBeNull();
  });

  test("weighs each skill, sorts descending and keeps five", () => {
    const skills = ["a", "b", "c", "d", "e", "f"].map((id, i) => ({
      id,
      slug: i % 2 === 0 ? `slug-${id}` : null,
    }));
    const weights: Record<string, number> = { a: 5, b: 60, c: 30, d: 1, e: 40, f: 20 };
    expect(topSkillsByTokens(skills, 600, (s) => weights[s.id] ?? 0)).toStrictEqual([
      { id: "b", tokens: 60 },
      { slug: "slug-e", tokens: 40 },
      { slug: "slug-c", tokens: 30 },
      { id: "f", tokens: 20 },
      { slug: "slug-a", tokens: 5 },
    ]);
  });

  test("duplicate ids reuse the first skill with that id", () => {
    const skills = [
      { id: "a", slug: "first" },
      { id: "a", slug: "second" },
    ];
    expect(topSkillsByTokens(skills, 0, (s) => (s.slug === "first" ? 7 : 3))).toStrictEqual([
      { slug: "first", tokens: 7 },
      { slug: "second", tokens: 7 },
    ]);
  });

  test("a failing weigher keeps the even share for the rest", () => {
    const skills = [{ id: "a" }, { id: "b" }, { id: "c" }];
    let calls = 0;
    const weigh = () => {
      calls += 1;
      if (calls === 2) throw new Error("tokenizer");
      return 100;
    };
    expect(topSkillsByTokens(skills, 31, weigh)).toStrictEqual([
      { id: "a", tokens: 100 },
      { id: "b", tokens: 10 },
      { id: "c", tokens: 10 },
    ]);
    expect(
      topSkillsByTokens(skills, undefined, () => {
        throw new Error("tokenizer");
      }),
    ).toStrictEqual([
      { id: "a", tokens: 0 },
      { id: "b", tokens: 0 },
      { id: "c", tokens: 0 },
    ]);
  });
});

describe("critic artifact", () => {
  test("validated step count counts passing *_validated checkpoints", () => {
    expect(
      validatedStepCount({
        connector_validated: { ok: true },
        workflow_validated: { ok: false },
        probe_validated: undefined,
        dry_run_passed: { ok: true },
        auth_validated: { ok: null },
        schema_validated: { ok: true },
      }),
    ).toBe(2);
    expect(validatedStepCount(undefined)).toBe(0);
  });

  test("trigger kind is the first step kind when it is a string", () => {
    expect(
      workflowTriggerKind(
        draftWith({ workflow: { steps: [{ kind: "webhook" }, { kind: "call" }] } }),
      ),
    ).toBe("webhook");
    expect(workflowTriggerKind(draftWith({ workflow: { steps: [{ kind: 3 }] } }))).toBeNull();
    expect(workflowTriggerKind(draftWith({ workflow: { steps: [] } }))).toBeNull();
    expect(workflowTriggerKind(draftWith({ workflow: {} }))).toBeNull();
    expect(workflowTriggerKind({} as DraftDocument)).toBeNull();
  });

  test("an uncommitted turn reviews the chat answer", () => {
    expect(
      reviewArtifact({ draft: draftWith({}), committedWorkflowId: null, assistantText: "hi" }),
    ).toStrictEqual({ kind: "chat", payload: "hi" });
  });

  test("a commit without a connector or workflow target is not reviewed", () => {
    for (const draft of [
      draftWith({}),
      draftWith({ summary: { active_target: { kind: "none" } } }),
    ]) {
      expect(reviewArtifact({ draft, committedWorkflowId: "wf", assistantText: "x" })).toBeNull();
    }
  });

  test("a workflow commit carries its trigger and validated steps", () => {
    const draft = draftWith({
      summary: { active_target: { kind: "workflow" } },
      connector: { auth_type: "oauth2" },
      workflow: { steps: [{ kind: "schedule" }] },
      state: { checkpoints: { workflow_validated: { ok: true } } },
    });
    expect(
      reviewArtifact({ draft, committedWorkflowId: "wf", assistantText: "saved" }),
    ).toStrictEqual({
      kind: "save_workflow_draft",
      payload: {
        resource_kind: "workflow",
        resource_id: "wf",
        connector_auth_mode: null,
        workflow_trigger_kind: "schedule",
        validated_step_count: 1,
        committed_text: "saved",
        referenced_credentials: [],
      },
    });
  });

  test("a connector commit carries its auth mode", () => {
    const base = {
      summary: { active_target: { kind: "connector" } },
      workflow: { steps: [{ kind: "schedule" }] },
    };
    expect(
      reviewArtifact({
        draft: draftWith({ ...base, connector: { auth_type: "api_key" } }),
        committedWorkflowId: "c",
        assistantText: "",
      }),
    ).toStrictEqual({
      kind: "save_workflow_draft",
      payload: {
        resource_kind: "connector",
        resource_id: "c",
        connector_auth_mode: "api_key",
        workflow_trigger_kind: null,
        validated_step_count: 0,
        committed_text: "",
        referenced_credentials: [],
      },
    });
    const noAuth = reviewArtifact({
      draft: draftWith(base),
      committedWorkflowId: "c",
      assistantText: "",
    });
    expect(noAuth?.kind === "save_workflow_draft" && noAuth.payload.connector_auth_mode).toBeNull();
  });
});

describe("critic verdicts", () => {
  test("failed checks are the keys whose value is exactly false", () => {
    expect(failedChecks({ a: false, b: true, c: 0, d: null, e: false })).toStrictEqual(["a", "e"]);
    expect(failedChecks(undefined)).toStrictEqual([]);
  });

  test("a commit abstains on a low-confidence failure", () => {
    expect(commitAbstains({ verdict: "fail", confidence: 0.59 }, true)).toBe(true);
    expect(commitAbstains({ verdict: "fail", confidence: 0.6 }, true)).toBe(false);
    expect(commitAbstains({ verdict: "pass", confidence: 0.1 }, true)).toBe(false);
    expect(commitAbstains({ verdict: "fail", confidence: 0.1 }, false)).toBe(false);
  });

  test("faithfulness abstention explains the source drift", () => {
    const critic = { reason: "r", hint: "h", confidence: 0.4 };
    expect(
      abstentionRequest({
        faithfulness: {
          reason: "quote missing",
          detail: "id 3",
          confidence: 0.8,
          checks: { ids_resolve: true, quotes_grounded: false },
        },
        critic,
        criticFailedChecks: ["x"],
      }),
    ).toStrictEqual({
      source: "source_faithful.abstention",
      summary: "source drift: quote missing",
      question:
        "The answer may not be faithful to the sources it cited. Reason: quote missing. Detail: id 3. Confirm the answer is correct, or describe what should change.",
      confidence: 0.8,
      checks: ["quotes_grounded"],
    });
    expect(
      abstentionRequest({
        faithfulness: { reason: "q", confidence: 0.5 },
        critic,
        criticFailedChecks: [],
      }),
    ).toStrictEqual({
      source: "source_faithful.abstention",
      summary: "source drift: q",
      question:
        "The answer may not be faithful to the sources it cited. Reason: q. Confirm the answer is correct, or describe what should change.",
      confidence: 0.5,
      checks: [],
    });
  });

  test("critic abstention explains the low-confidence commit", () => {
    expect(
      abstentionRequest({
        faithfulness: null,
        critic: { reason: "no probe", hint: "probe first", confidence: 0.3 },
        criticFailedChecks: ["probe"],
      }),
    ).toStrictEqual({
      source: "critic.abstention",
      summary: "low-confidence commit: no probe",
      question:
        "The critic flagged this commit with low confidence. Reason: no probe. Suggested fix: probe first. Confirm the commit, or describe what should change.",
      confidence: 0.3,
      checks: ["probe"],
    });
    expect(
      abstentionRequest({
        faithfulness: null,
        critic: { reason: "r", hint: null, confidence: 0.3 },
        criticFailedChecks: [],
      }).question,
    ).toBe(
      "The critic flagged this commit with low confidence. Reason: r. Confirm the commit, or describe what should change.",
    );
  });

  test("elicitation actor type falls back to system or unknown", () => {
    expect(elicitationActorType("user", "u")).toBe("user");
    expect(elicitationActorType(undefined, null)).toBe("system");
    expect(elicitationActorType(undefined, "u")).toBe("unknown");
  });
});

describe("turn outcome", () => {
  const base = {
    cancelled: false,
    persistedStatus: "active",
    cancelledByConversation: false,
    committedWorkflowId: null,
    savedInertDraft: false,
    pendingElicitationId: undefined,
    hasPendingElicitation: false,
  };

  test("a saved inert draft is a workflow draft persisted as draft", () => {
    const draft = (resources: unknown[]) =>
      draftWith({ state: { persisted_resources: resources } });
    expect(
      savedInertDraft(draft([{ kind: "workflow", id: "wf", persistence_kind: "draft" }]), "wf"),
    ).toBe(true);
    expect(
      savedInertDraft(draft([{ kind: "workflow", id: "wf", persistence_kind: "active" }]), "wf"),
    ).toBe(false);
    expect(
      savedInertDraft(draft([{ kind: "workflow", id: "x", persistence_kind: "draft" }]), "wf"),
    ).toBe(false);
    expect(
      savedInertDraft(draft([{ kind: "connector", id: "wf", persistence_kind: "draft" }]), "wf"),
    ).toBe(false);
    expect(savedInertDraft(draftWith({}), "wf")).toBe(false);
    expect(
      savedInertDraft(
        draft([
          { kind: "connector", id: "c", persistence_kind: "active" },
          { kind: "workflow", id: "wf", persistence_kind: "draft" },
        ]),
        "wf",
      ),
    ).toBe(true);
  });

  test("any cancellation abandons the turn", () => {
    for (const patch of [
      { cancelled: true },
      { persistedStatus: "abandoned" },
      { cancelledByConversation: true },
    ]) {
      expect(turnOutcome({ ...base, ...patch, committedWorkflowId: "wf" })).toStrictEqual({
        status: "abandoned",
        parkable: false,
      });
    }
  });

  test("a commit is committed unless it saved an inert draft", () => {
    expect(
      turnOutcome({ ...base, committedWorkflowId: "wf", hasPendingElicitation: true }),
    ).toStrictEqual({
      status: "committed",
      committed_workflow_id: "wf",
      parkable: false,
    });
    expect(
      turnOutcome({ ...base, committedWorkflowId: "wf", savedInertDraft: true }),
    ).toStrictEqual({
      status: "active",
      committed_workflow_id: "wf",
      parkable: false,
    });
  });

  test("a pending question or persisted wait keeps the turn awaiting input", () => {
    expect(
      turnOutcome({ ...base, hasPendingElicitation: true, pendingElicitationId: "el" }),
    ).toStrictEqual({ status: "awaiting_input", pending_elicitation_id: "el", parkable: false });
    expect(turnOutcome({ ...base, persistedStatus: "awaiting_input" })).toStrictEqual({
      status: "awaiting_input",
      pending_elicitation_id: undefined,
      parkable: false,
    });
  });

  test("otherwise the turn stays active and may be parked", () => {
    expect(turnOutcome(base)).toStrictEqual({ status: "active", parkable: true });
    expect(turnOutcome({ ...base, persistedStatus: null })).toStrictEqual({
      status: "active",
      parkable: true,
    });
  });
});
