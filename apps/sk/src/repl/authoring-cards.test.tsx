// Unit tests for extractKnowledgeSourceSummary (Fix #3) and
// isPolicyGatePending / renderAuthoringCard (Fix #4).
//
// Both helpers operate on plain ToolCallState fixtures — no React
// rendering is needed for the pure-function assertions in Fix #3 and
// the isPolicyGatePending predicate in Fix #4. renderAuthoringCard
// is tested at the null / non-null level: we verify it returns null
// when a policy-pending call is in chat mode, and non-null when the
// same call is in inspect mode.

import { describe, expect, test } from "bun:test";
import type { ToolCallState } from "@cli-core/index.ts";
import {
  extractKnowledgeSourceSummary,
  isPolicyGatePending,
  renderAuthoringCard,
} from "./authoring-cards.tsx";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeKsCall(overrides: {
  resultMimeType?: string;
  argMimeType?: string;
  argMode?: "inline" | "from_attachment";
  fileId?: string;
  includeResultMime?: boolean;
}): ToolCallState {
  const {
    resultMimeType,
    argMimeType,
    argMode = "from_attachment",
    fileId,
    includeResultMime = true,
  } = overrides;

  const ksResult: Record<string, unknown> = {
    id: "ks-001",
    name: "OCPP-2.0.1",
    slug: "ocpp-201",
    scope: "global",
    status: "ready",
    chunk_count: 42,
    bytes_total: 128_000,
  };
  if (includeResultMime && resultMimeType !== undefined) {
    ksResult.mime_type = resultMimeType;
  }

  const args: Record<string, unknown> = {
    mode: argMode,
    file_id: fileId ?? "fid_00000000-0000-0000-0000-000000000001",
  };
  if (argMimeType !== undefined) {
    args.mime_type = argMimeType;
  }

  return {
    id: "call-ks-001",
    name: "create_knowledge_source",
    args,
    status: "done",
    result: {
      ok: true,
      data: {
        created: true,
        knowledge_source: ksResult,
        audit_log_id: "al-001",
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

// ---------------------------------------------------------------------------
// Fix #3 — extractKnowledgeSourceSummary reads content_type from engine
// ---------------------------------------------------------------------------

describe("extractKnowledgeSourceSummary — mime_type resolution order", () => {
  test("engine-echoed mime_type wins over mode-derived fallback", () => {
    const call = makeKsCall({ resultMimeType: "text/markdown", argMode: "from_attachment" });
    const summary = extractKnowledgeSourceSummary(call);
    expect(summary).not.toBeNull();
    expect(summary?.mime_type).toBe("text/markdown");
  });

  test("engine-echoed mime_type wins over args.mime_type (engine is authoritative)", () => {
    const call = makeKsCall({
      resultMimeType: "text/markdown",
      argMimeType: "application/pdf",
      argMode: "from_attachment",
    });
    const summary = extractKnowledgeSourceSummary(call);
    expect(summary?.mime_type).toBe("text/markdown");
  });

  test("when engine result lacks mime_type AND args has mime_type, args wins", () => {
    // Simulate an older engine that doesn't echo mime_type back.
    const call = makeKsCall({
      includeResultMime: false,
      argMimeType: "text/markdown",
      argMode: "from_attachment",
    });
    const summary = extractKnowledgeSourceSummary(call);
    expect(summary?.mime_type).toBe("text/markdown");
  });

  test("when neither carries mime_type and mode=inline, fallback is text/markdown", () => {
    const call = makeKsCall({
      includeResultMime: false,
      argMode: "inline",
    });
    // No argMimeType set, no resultMimeType set.
    const summary = extractKnowledgeSourceSummary(call);
    expect(summary?.mime_type).toBe("text/markdown");
  });

  test("when neither carries mime_type and mode=from_attachment, fallback is application/octet-stream", () => {
    // Last-resort backward compatibility for older engines that did not
    // echo the MIME. The from_attachment branch can't know the type
    // without querying the file row again, so octet-stream is the safe
    // default.
    const call = makeKsCall({
      includeResultMime: false,
      argMode: "from_attachment",
    });
    const summary = extractKnowledgeSourceSummary(call);
    expect(summary?.mime_type).toBe("application/octet-stream");
  });

  test("args.file_id is preserved in the summary's file_id field", () => {
    const call = makeKsCall({ fileId: "fid_unique-test-id" });
    const summary = extractKnowledgeSourceSummary(call);
    expect(summary?.file_id).toBe("fid_unique-test-id");
  });

  test("empty-string mime_type from engine falls through to next tier (no '' label)", () => {
    // Code-review hardening: `??` only treats nullish as missing, so a
    // future engine that returns `mime_type: ""` would surface as an
    // empty content-type label. Coerce empty strings to "missing" so
    // the chain falls through to the args / mode default.
    const call = makeKsCall({
      resultMimeType: "",
      argMimeType: "text/markdown",
      argMode: "from_attachment",
    });
    const summary = extractKnowledgeSourceSummary(call);
    expect(summary?.mime_type).toBe("text/markdown");
  });

  test("empty-string args.mime_type also falls through (no '' label)", () => {
    const call = makeKsCall({
      includeResultMime: false,
      argMimeType: "",
      argMode: "from_attachment",
    });
    const summary = extractKnowledgeSourceSummary(call);
    expect(summary?.mime_type).toBe("application/octet-stream");
  });

  test("returns null when result.knowledge_source is absent", () => {
    const call: ToolCallState = {
      id: "call-no-ks",
      name: "create_knowledge_source",
      args: { mode: "from_attachment", file_id: "fid_x" },
      status: "done",
      result: { ok: true, data: { created: true, audit_log_id: "al-x" } },
    };
    const summary = extractKnowledgeSourceSummary(call);
    expect(summary).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Fix #4 — isPolicyGatePending predicate
// ---------------------------------------------------------------------------

describe("isPolicyGatePending", () => {
  test("returns true for a full confirm_before_execution sentinel envelope", () => {
    const call = makePolicyPendingCall();
    expect(isPolicyGatePending(call)).toBe(true);
  });

  test("returns false when policy_mode is missing (generic {pending: true} must not false-positive)", () => {
    // A tool that returns `{ pending: true }` for other reasons (e.g. a
    // background job) must NOT be suppressed as if it were policy-gated.
    const call = makePolicyPendingCall({ includePolicyMode: false });
    expect(isPolicyGatePending(call)).toBe(false);
  });

  test("returns false for a genuine success result ({created: true})", () => {
    const call = makeKsCall({ resultMimeType: "text/markdown" });
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
    // Code-review hardening: a previous draft used `startsWith("confirm_")`
    // which would catch a future after-execution flow and silently
    // suppress real result cards.
    const call = makePolicyPendingCall({ policyMode: "confirm_after_execution" });
    expect(isPolicyGatePending(call)).toBe(false);
  });

  test("returns true with case-folded policy_mode (CONFIRM_BEFORE_EXECUTION)", () => {
    // Defensive: case-folded so a future emitter that capitalises the
    // policy_mode string doesn't slip past the predicate.
    const call = makePolicyPendingCall({ policyMode: "CONFIRM_BEFORE_EXECUTION" });
    expect(isPolicyGatePending(call)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fix #8 — meta-authoring tools suppressed in chat (6.2.13)
// ---------------------------------------------------------------------------

describe("renderAuthoringCard — meta-authoring tools suppressed in chat (Fix #8, 6.2.13)", () => {
  // validate_draft, inspect_workflow_draft, inspect_connector_draft were
  // removed from IN_FLIGHT_VISIBLE_TOOLS. In chat mode the operator should
  // never see their in-flight or completion cards — the assistant's text
  // narrative is what surfaces instead.

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

  test("propose_step still renders in chat mode while running (positive control — must not be over-suppressed)", () => {
    const call: ToolCallState = {
      id: "call-propose_step",
      name: "propose_step",
      args: {},
      status: "running",
    };
    expect(renderAuthoringCard(call, "chat")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Fix #4 — renderAuthoringCard dispatcher with policy-pending
// ---------------------------------------------------------------------------

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
    const call = makeKsCall({ resultMimeType: "text/markdown" });
    const result = renderAuthoringCard(call, "chat");
    // Not null — the genuine success card should render.
    expect(result).not.toBeNull();
  });

  test("generic {pending:true} without policy_mode does NOT suppress (renders normally)", () => {
    // If a tool returns `{pending: true}` for a non-policy reason, the
    // card must NOT be suppressed in chat mode.
    const call = makePolicyPendingCall({ includePolicyMode: false });
    // isPolicyGatePending returns false, so the dispatcher falls through
    // to the switch — create_knowledge_source with this shape will try
    // extractKnowledgeSourceSummary (returns null since `knowledge_source`
    // key is missing) and fall back to GenericMilestoneCard, which is
    // non-null.
    const result = renderAuthoringCard(call, "chat");
    expect(result).not.toBeNull();
  });
});
