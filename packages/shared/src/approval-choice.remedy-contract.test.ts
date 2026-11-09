import { expect, test } from "bun:test";
import {
  type ApprovalRemedy,
  approvalChoice,
  approvalRemedy,
  type EnvironmentBlockIn,
} from "./approval-choice.ts";

const block = (
  environment: "dev" | "prod",
  code: EnvironmentBlockIn["code"] = "connector_missing",
  step_id: string = environment,
): EnvironmentBlockIn => ({ environment, code, step_id, connector_id: null, connector_name: null });
const remedy = (environment: "dev" | "prod", step_id: string = environment): ApprovalRemedy => ({
  kind: "open_connector",
  environment,
  step_id,
  connector_id: null,
});

test("remedies favor the environment with fewer blockers unless a present preference is given", () => {
  const reasons = [
    block("dev", "connector_missing", "dev-a"),
    block("dev", "connector_missing", "dev-b"),
    block("prod"),
  ];
  expect(approvalRemedy(reasons)).toEqual(remedy("prod"));
  expect(approvalRemedy(reasons, "dev")).toEqual(remedy("dev", "dev-a"));
  expect(approvalRemedy([block("prod")], "dev")).toEqual(remedy("prod"));
  expect(approvalRemedy([block("dev")], "prod")).toEqual(remedy("dev"));
  expect(
    approvalRemedy([block("prod"), block("prod", "connector_missing", "prod-b"), block("dev")]),
  ).toEqual(remedy("dev"));
  expect(approvalRemedy([block("prod"), block("dev")])).toEqual(remedy("dev"));
  expect(approvalRemedy([], "prod")).toBeNull();
});

test("reauthentication takes priority over other connector repairs", () => {
  const reasons = [
    block("dev"),
    block("dev", "connector_switched_off", "off"),
    block("dev", "connector_without_sign_in", "unsigned"),
    block("dev", "connector_needs_sign_in_again", "expired"),
  ];
  expect(approvalRemedy(reasons)).toEqual({
    kind: "sign_in_again",
    environment: "dev",
    step_id: "expired",
    connector_id: null,
  });
  expect(approvalRemedy(reasons.slice(0, 3))).toEqual(remedy("dev", "unsigned"));
  expect(approvalRemedy(reasons.slice(0, 2))).toEqual(remedy("dev", "off"));
});

test("none-possible recommendations retain every blocker even when possibility flags disagree", () => {
  const dev = block("dev"),
    prod = block("prod");
  expect(
    approvalChoice({
      environments: {
        dev: { possible: true, reasons: [dev] },
        prod: { possible: true, reasons: [prod] },
      },
      recommended_environment: { environment: "dev", reason: "none_possible" },
    }),
  ).toEqual({ kind: "none", reasons: [dev, prod] });
});

test("incomplete preview assessments are handled conservatively", () => {
  const environments = { prod: { possible: true, reasons: [block("prod")] } };
  const partial = {
    environments,
    recommended_environment: { environment: "prod", reason: "existing_approval" },
  };
  expect(approvalChoice(partial as unknown as Parameters<typeof approvalChoice>[0])).toEqual({
    kind: "single",
    environment: "prod",
    reason: "existing_approval",
  });
  expect(
    approvalChoice({
      ...partial,
      recommended_environment: { environment: null, reason: "none_possible" },
    } as unknown as Parameters<typeof approvalChoice>[0]),
  ).toEqual({ kind: "none", reasons: [block("prod")] });
});

test("manual approval remains a single choice when the other environment is missing", () => {
  const partial = {
    environments: { prod: { possible: true, reasons: [] } },
    recommended_environment: { environment: "prod", reason: "started_manually" },
  };
  expect(approvalChoice(partial as unknown as Parameters<typeof approvalChoice>[0])).toEqual({
    kind: "single",
    environment: "prod",
    reason: "started_manually",
  });
});
