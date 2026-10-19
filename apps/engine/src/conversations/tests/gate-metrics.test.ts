import { beforeEach, describe, expect, test } from "bun:test";
import {
  getMetrics,
  METRIC_NAMES,
  resetMetricsRegistryForTests,
} from "../../observability/metrics.ts";
import { makeStubDb, makeTestPrincipal, usePolicyFixture } from "../../tools/tests/_helpers.ts";
import {
  type ConfirmGateInput,
  type GateRecord,
  logGateDecision,
  runConfirmGate,
} from "../confirmation.ts";
import { CONVERSATION_SURFACES, type ConversationSurface } from "../lifecycle-view.ts";

usePolicyFixture();

const PRINCIPAL = makeTestPrincipal();
const CONVERSATION_ID = "00000000-0000-0000-0000-000000000003";

function gateInput(
  db: ConfirmGateInput["db"],
  surface: ConversationSurface,
  overrides: Partial<ConfirmGateInput> = {},
): ConfirmGateInput {
  return {
    tool: "imaginary_tenant_write_tool",
    category: "tenant_write",
    surface: "chat",
    args: { target: "x" },
    db,
    tenant_id: PRINCIPAL.tenant_id,
    principal: PRINCIPAL,
    approval_tool: "imaginary_tenant_write_tool",
    via: "chat",
    record_surface: surface,
    conversation_id: CONVERSATION_ID,
    actor_id: PRINCIPAL.id,
    execution_mode: null,
    precheck: null,
    pause_blocked: false,
    confirmation_kind: "external_write",
    ...overrides,
  };
}

function decisionCount(labels: Record<string, string>): number | undefined {
  const series = getMetrics()
    .snapshot()
    .find((s) => s.name === METRIC_NAMES.TOOL_POLICY_DECISION_TOTAL);
  return series?.samples.find((s) => Object.entries(labels).every(([k, v]) => s.labels[k] === v))
    ?.value;
}

beforeEach(() => {
  resetMetricsRegistryForTests();
});

describe("tool_policy_decision_total — one gated call, counted once on every surface", () => {
  for (const surface of CONVERSATION_SURFACES) {
    test(`a confirm reached from ${surface} increments rule, mode, outcome and surface`, async () => {
      const { db } = makeStubDb();
      const result = await runConfirmGate(gateInput(db, surface));
      expect(result.kind).toBe("needs_confirm");
      expect(
        decisionCount({
          rule: "category_default",
          mode: "confirm_before_execution",
          outcome: "confirm",
          surface,
        }),
      ).toBe(1);
      expect(getMetrics().counterSum(METRIC_NAMES.TOOL_POLICY_DECISION_TOTAL)).toBe(1);
    });
  }

  test("a proceed, a refusal and a blocked pause each carry their own outcome", async () => {
    const { db } = makeStubDb();
    await runConfirmGate(
      gateInput(db, "web", { tool: "preview_attachment", category: "tenant_read" }),
    );
    await runConfirmGate(
      gateInput(db, "mcp", {
        precheck: async () => ({ ok: false, result: { ok: false, data: {} } }),
      }),
    );
    await runConfirmGate(gateInput(db, "sk_interactive", { pause_blocked: true }));
    expect(decisionCount({ outcome: "proceed", mode: "no_confirm", surface: "web" })).toBe(1);
    expect(decisionCount({ outcome: "refused", surface: "mcp" })).toBe(1);
    expect(decisionCount({ outcome: "duplicate_pending", surface: "sk_interactive" })).toBe(1);
    expect(getMetrics().counterSum(METRIC_NAMES.TOOL_POLICY_DECISION_TOTAL)).toBe(3);
  });

  test("the held-writes rule is part of the vocabulary", () => {
    const record: GateRecord = {
      tool: "wf_daily_report",
      category: "tenant_write",
      rule: "held_writes",
      mode: "confirm_before_execution",
      outcome: "confirm",
      surface: "chat",
      bypassed_confirmation: false,
      tenant_id: PRINCIPAL.tenant_id,
      conversation_id: CONVERSATION_ID,
    };
    logGateDecision(record);
    expect(decisionCount({ rule: "held_writes", outcome: "confirm", surface: "chat" })).toBe(1);
  });
});
