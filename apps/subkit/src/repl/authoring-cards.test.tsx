import { describe, expect, test } from "bun:test";
import type { ToolCallState } from "@cli-core/index.ts";
import { render } from "ink-testing-library";
import type { ReactElement } from "react";
import { isPolicyGatePending, renderAuthoringCard } from "./authoring-cards.tsx";

function frameOf(call: ToolCallState, mode: "chat" | "inspect" = "chat"): string {
  const node = renderAuthoringCard(call, mode);
  expect(node).not.toBeNull();
  const r = render(node as ReactElement);
  const frame = (r.lastFrame() ?? "").replace(/\[[0-9;]*m/g, "");
  r.unmount();
  return frame;
}

function makeCollectedCall(): ToolCallState {
  return {
    id: "call-ks-001",
    name: "create_knowledge_source",
    args: { file_id: "fid_00000000-0000-0000-0000-000000000001" },
    status: "done",
    result: {
      ok: true,
      data: {
        collected: true,
        admitted: false,
        intake_item: { id: "item-001", title: "OCPP-2.0.1", category: "inbox", state: "collected" },
        next_action: "review",
      },
    },
  };
}

function makePolicyPendingCall(
  overrides: { policyMode?: string; includePolicyMode?: boolean } = {},
): ToolCallState {
  const { policyMode = "confirm_before_execution", includePolicyMode = true } = overrides;
  const result: Record<string, unknown> = {
    pending: true,
    status: "awaiting_confirmation",
    elicitation_id: "elic-001",
    note: "policy_confirm_required: operator must approve before the side effect runs",
  };
  if (includePolicyMode) {
    result.policy_mode = policyMode;
  }
  return {
    id: "call-ks-pending",
    name: "create_knowledge_source",
    args: { mode: "from_attachment", file_id: "fid_abc" },
    status: "done",
    result,
  };
}

describe("create_knowledge_source collects an item for review", () => {
  test("the card says the item waits for review and is not knowledge yet", () => {
    const frame = frameOf(makeCollectedCall());
    expect(frame).toContain("Item collected for review");
    expect(frame).toContain("OCPP-2.0.1");
    expect(frame).toContain("Not in knowledge yet");
    expect(frame).not.toContain("Created knowledge source");
  });
});

describe("isPolicyGatePending", () => {
  test("returns true for a full confirm_before_execution sentinel envelope", () => {
    const call = makePolicyPendingCall();
    expect(isPolicyGatePending(call)).toBe(true);
  });

  test("returns false when policy_mode is missing (generic {pending: true} must not false-positive)", () => {
    const call = makePolicyPendingCall({ includePolicyMode: false });
    expect(isPolicyGatePending(call)).toBe(false);
  });

  test("returns false for a genuine success result ({created: true})", () => {
    const call = makeCollectedCall();
    expect(isPolicyGatePending(call)).toBe(false);
  });

  test("returns false when result is undefined", () => {
    const call: ToolCallState = {
      id: "call-no-result",
      name: "create_knowledge_source",
      args: {},
      status: "running",
    };
    expect(isPolicyGatePending(call)).toBe(false);
  });

  test("returns false for confirm_after_execution (only confirm_before_execution emits this envelope)", () => {
    const call = makePolicyPendingCall({ policyMode: "confirm_after_execution" });
    expect(isPolicyGatePending(call)).toBe(false);
  });

  test("returns true with case-folded policy_mode (CONFIRM_BEFORE_EXECUTION)", () => {
    const call = makePolicyPendingCall({ policyMode: "CONFIRM_BEFORE_EXECUTION" });
    expect(isPolicyGatePending(call)).toBe(true);
  });
});

describe("renderAuthoringCard — meta-authoring tools suppressed in chat (Fix #8, 6.2.13)", () => {
  const META_TOOLS = [
    "validate_draft",
    "inspect_workflow_draft",
    "inspect_connector_draft",
  ] as const;

  for (const name of META_TOOLS) {
    test(`${name}: returns null in chat mode when status=running`, () => {
      const call: ToolCallState = {
        id: `call-${name}`,
        name,
        args: {},
        status: "running",
      };
      expect(renderAuthoringCard(call, "chat")).toBeNull();
    });

    test(`${name}: returns null in chat mode when status=done`, () => {
      const call: ToolCallState = {
        id: `call-${name}`,
        name,
        args: {},
        status: "done",
        result: { ok: true, data: {} },
      };
      expect(renderAuthoringCard(call, "chat")).toBeNull();
    });

    test(`${name}: returns non-null in inspect mode (diagnostic visibility preserved)`, () => {
      const call: ToolCallState = {
        id: `call-${name}`,
        name,
        args: {},
        status: "done",
        result: { ok: true, data: {} },
      };
      expect(renderAuthoringCard(call, "inspect")).not.toBeNull();
    });
  }

  test("author_workflow still renders in chat mode while running (positive control — must not be over-suppressed)", () => {
    const call: ToolCallState = {
      id: "call-author_workflow",
      name: "author_workflow",
      args: {},
      status: "running",
    };
    expect(renderAuthoringCard(call, "chat")).not.toBeNull();
  });
});

function makeAuthorWorkflowCall(overrides: {
  recordedEval?: Record<string, unknown>;
  attempts?: number;
}): ToolCallState {
  const { recordedEval, attempts = 1 } = overrides;
  return {
    id: "call-author-wf",
    name: "author_workflow",
    args: { goal: "Email me the droplet specs of every DigitalOcean project" },
    status: "done",
    result: {
      ok: true,
      data: {
        name: "DO Email",
        workflow: {
          name: "DO Email",
          slug: "do-email",
          goal: "Email me the droplet specs of every DigitalOcean project",
          step_count: 4,
        },
        definition: {
          name: "DO Email",
          slug: "do-email",
          steps: [
            { id: "fetch_projects", kind: "request" },
            { id: "fetch_resources", kind: "request" },
            { id: "shape", kind: "transform" },
            { id: "send_email", kind: "request" },
          ],
        },
        validation: { ok: true, errors: [] },
        recorded_eval: recordedEval ?? {
          ok: true,
          summary:
            "recorded evaluation passed: expressions compile and resolve against recorded evidence",
          expressions: [],
          scope_refs: [],
          gates: { loop: { ok: true, blocks: [] }, transform: { ok: true, blocks: [] } },
          missing_evidence: [],
          next_actions: [],
        },
        attempts,
        persistence: "draft_only",
        next_step: "dry_run_workflow",
      },
    },
  };
}

describe("renderAuthoringCard — author_workflow milestone card", () => {
  test("clean recorded eval: renders name, slug, step kinds, attempts, and next action", () => {
    const frame = frameOf(makeAuthorWorkflowCall({}));
    expect(frame).toContain("Workflow authored");
    expect(frame).toContain("DO Email");
    expect(frame).toContain("do-email");
    expect(frame).toContain("4 steps (request×3, transform)");
    expect(frame).toContain("1 attempt");
    expect(frame).toContain("evaluated clean against recorded evidence");
    expect(frame).toContain("→ dry_run_workflow");
  });

  test("findings: renders count by status plus the first finding's site + message", () => {
    const frame = frameOf(
      makeAuthorWorkflowCall({
        attempts: 2,
        recordedEval: {
          ok: false,
          summary: "2 findings",
          expressions: [
            { site: "steps.fetch_projects.expression", step_id: "fetch_projects", status: "ok" },
            {
              site: "steps.shape.expression",
              step_id: "shape",
              status: "eval_error",
              message: "$scope.fetch_resources.data.items is not an array",
            },
            {
              site: "output_transform",
              step_id: null,
              status: "empty_result",
              message: "expression produced an empty result over non-empty evidence",
            },
          ],
          scope_refs: [],
          gates: { loop: { ok: true, blocks: [] }, transform: { ok: false, blocks: [] } },
          missing_evidence: [],
          next_actions: ["edit_workflow_patch"],
        },
      }),
    );
    expect(frame).toContain("recorded eval: 2 findings (1 eval_error, 1 empty_result)");
    expect(frame).toContain("steps.shape.expression");
    expect(frame).toContain("is not an array");
    expect(frame).toContain("2 attempts");
    expect(frame).toContain("→ dry_run_workflow");
    expect(frame).not.toContain("3 findings");
  });

  test("failure envelope renders the refusal, not a success card", () => {
    const call: ToolCallState = {
      id: "call-author-wf-fail",
      name: "author_workflow",
      args: {},
      status: "done",
      result: {
        ok: false,
        data: {
          error: "authoring_connectors_unresolved",
          error_code: "authoring_connectors_unresolved",
          message: "connector slug `digtalocean` did not resolve for this tenant",
        },
      },
    };
    const frame = frameOf(call);
    expect(frame).toContain("Workflow authoring failed");
    expect(frame).toContain("authoring_connectors_unresolved");
    expect(frame).toContain("did not resolve");
    expect(frame).not.toContain("Workflow authored ·");
  });

  test("author_workflow is in-flight visible in chat mode", () => {
    const call: ToolCallState = {
      id: "call-author-wf-running",
      name: "author_workflow",
      args: { goal: "g" },
      status: "running",
    };
    expect(renderAuthoringCard(call, "chat")).not.toBeNull();
  });
});

describe("renderAuthoringCard — start_workflow_from_goal removed", () => {
  const doneCall: ToolCallState = {
    id: "call-swfg",
    name: "start_workflow_from_goal",
    args: {},
    status: "done",
    result: {
      ok: true,
      data: { workflow: { name: "Old Tool", definition: { steps: [] } } },
    },
  };

  test("returns null in chat mode for a completed call", () => {
    expect(renderAuthoringCard(doneCall, "chat")).toBeNull();
  });

  test("returns null in inspect mode (no dedicated case left)", () => {
    expect(renderAuthoringCard(doneCall, "inspect")).toBeNull();
  });

  test("returns null in chat mode while running (not in-flight visible)", () => {
    const running: ToolCallState = { ...doneCall, status: "running" };
    expect(renderAuthoringCard(running, "chat")).toBeNull();
  });
});

describe("renderAuthoringCard — policy-pending short-circuit", () => {
  test("returns null in chat mode when call is policy-pending and status=done", () => {
    const call = makePolicyPendingCall();
    const result = renderAuthoringCard(call, "chat");
    expect(result).toBeNull();
  });

  test("returns non-null in inspect mode for the same policy-pending call (renders InFlightToolCard)", () => {
    const call = makePolicyPendingCall();
    const result = renderAuthoringCard(call, "inspect");
    expect(result).not.toBeNull();
  });

  test("returns non-null (SummaryCard path) for a genuine success result in chat mode", () => {
    const call = makeCollectedCall();
    const result = renderAuthoringCard(call, "chat");
    expect(result).not.toBeNull();
  });

  test("generic {pending:true} without policy_mode does NOT suppress (renders normally)", () => {
    const call = makePolicyPendingCall({ includePolicyMode: false });
    const result = renderAuthoringCard(call, "chat");
    expect(result).not.toBeNull();
  });
});
