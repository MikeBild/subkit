import { describe, expect, test } from "bun:test";
import { ApiError } from "@/api/transport";
import { needsTwoApprovers } from "@/features/operations";
import { type TranslationKey, translate } from "@/lib/i18n";
import { nextPolicy, policyErrorRows, policyView } from "./approval-policy-model";

const t = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate("de", key, values);

describe("workspace approval policy", () => {
  test("an administrator switches between one and two approvers", () => {
    const single = policyView(
      { workflow_approvals: "single", eligible_approvers: 3 },
      ["rbac:write"],
      false,
      t,
    );
    expect(single).toEqual({
      on: false,
      disabled: false,
      hint: "Eine Person gibt frei · dürfen freigeben: 3",
    });
    const pair = policyView(
      { workflow_approvals: "pair", eligible_approvers: 2 },
      ["rbac:write"],
      false,
      t,
    );
    expect(pair.on).toBe(true);
    expect(pair.hint).toBe("Zwei Personen geben jeden Workflow frei");
    expect(nextPolicy(true)).toBe("pair");
    expect(nextPolicy(false)).toBe("single");
  });

  test("without rbac:write or while saving the switch is read-only", () => {
    const policy = { workflow_approvals: "pair", eligible_approvers: 2 } as const;
    expect(policyView(policy, ["workflow:read"], false, t).disabled).toBe(true);
    expect(policyView(policy, ["rbac:write"], true, t).disabled).toBe(true);
  });

  test("the refusal with fewer than two approvers shows only the counts", () => {
    const refused = new ApiError(
      409,
      {
        code: "pair_needs_two_approvers",
        message: "Two-person approval needs at least two active people",
        details: { eligible_approvers: 1 },
      },
      "trace-1",
    );
    expect(needsTwoApprovers(refused)).toBe(true);
    expect(policyErrorRows(refused, t)).toEqual([
      ["Personen, die freigeben dürfen", "1"],
      ["Gebraucht", "2"],
    ]);
    expect(policyErrorRows(new ApiError(500, {}, null), t)).toEqual([]);
  });
});
