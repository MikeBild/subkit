import { expect, test } from "bun:test";
import { automationState } from "@/lib/automation-state";
import {
  ACTIVE,
  authority,
  DRAFT,
  hooked,
  inputs,
  schedule,
  status,
} from "../automation-state-fixtures.ts";
import {
  automationActionKey,
  automationCard,
  carryOverChoice,
  recommendedAutomationEnvironment,
} from "./automation-presentation.ts";

test("automation presentation maps every standalone action and repair route to its catalog key", () => {
  expect(automationActionKey({ kind: "resume", scheduleIds: [] })).toBe("automation.action.resume");
  expect(automationActionKey({ kind: "apply" })).toBe("automation.action.apply");
  expect(automationActionKey({ kind: "grant" })).toBe("automation.action.grant");
  expect(automationActionKey({ kind: "extend" })).toBe("automation.action.extend");
  expect(automationActionKey({ kind: "view" })).toBe("automation.action.view");
  expect(
    (["review", "auto", "prepare", "chat"] as const).map((via) =>
      automationActionKey({ kind: "repair", via, stepId: null }),
    ),
  ).toEqual(["remedy.reviewRepair", "diagnosis.repair", "diagnosis.prepare", "remedy.chat"]);
});

test("automation presentation only adopts a complete repeatable activation", () => {
  const preview = {
    approval_carries_over: true,
    eligible_for_repeated_runs: true,
    execution_shape: {
      requests: [{ request_review_truncated: false, opaque_payload_omitted: false }],
    },
  };
  expect(carryOverChoice(preview, true)).toBe("adopt");
  expect(carryOverChoice(preview, false)).toBe("review");
  expect(carryOverChoice({ ...preview, approval_carries_over: false }, true)).toBe("review");
  expect(
    carryOverChoice(
      { ...preview, execution_shape: { requests: [{ opaque_payload_omitted: true }] } },
      true,
    ),
  ).toBe("review");
  expect(
    carryOverChoice(
      {
        ...preview,
        execution_shape: {
          requests: [
            { request_review_truncated: true, opaque_payload_omitted: false },
            { request_review_truncated: false, opaque_payload_omitted: false },
          ],
        },
      },
      true,
    ),
  ).toBe("review");
  expect(
    recommendedAutomationEnvironment({ recommended_environment: { environment: "dev" } }),
  ).toBe("dev");
  expect(recommendedAutomationEnvironment({})).toBeNull();
});

test("automation cards retain the actionable and calm state contracts", () => {
  const card = (input = inputs(), webhooks = 0) => automationCard(automationState(input), webhooks);
  const grantState = automationState(inputs());
  expect(automationCard({ ...grantState, pendingEnvironments: [] }, 0)).toMatchObject({
    act: "review",
    environments: [grantState.environment],
  });
  expect(card()).toMatchObject({ act: "review", actionKey: "automation.action.grant" });
  expect(
    card(
      inputs({
        workflow: {
          lifecycle: "active",
          current_version_id: ACTIVE,
          draft_version_id: DRAFT,
          current_version: 9,
        },
      }),
    ),
  ).toMatchObject({ act: "review", actionKey: "automation.action.apply" });
  expect(
    card(inputs({ status: status(["authorized"]), authorities: [authority()] })),
  ).toMatchObject({
    act: "none",
    titleKey: "chat.automationCard.authorized.title",
  });
  expect(card(inputs({ schedules: [], status: status() }))).toMatchObject({
    act: "none",
    hintKey: "automation.headline.manual",
  });
  expect(
    card(
      inputs({
        workflow: {
          lifecycle: "archived",
          current_version_id: ACTIVE,
          draft_version_id: ACTIVE,
          current_version: 9,
        },
      }),
    ),
  ).toMatchObject({ hintKey: "automation.headline.inactive" });
  expect(card(inputs({ workflow: { ...hooked, invalid: true } }))).toMatchObject({
    act: "none",
    titleKey: "automation.state.invalid",
    hintKey: "automation.headline.invalid",
  });
  expect(
    card(inputs({ schedules: [schedule({ paused: true })], status: status(["paused"]) })),
  ).toMatchObject({ act: "resume", actionKey: "automation.action.resume" });
  expect(card(inputs({ authorities: null }))).toMatchObject({
    act: "recheck",
    actionKey: "automation.action.recheck",
  });
  expect(card(inputs({ status: status(["repair_required"]), diagnosis: null }))).toMatchObject({
    act: "review",
    actionKey: "chat.automationCard.repair.action",
  });
  expect(
    card(inputs({ schedules: [], status: status([], ["paused"]), workflow: hooked })),
  ).toMatchObject({
    act: "none",
    hintKey: "automation.hookOff",
  });
  expect(
    card(inputs({ schedules: [], status: status([], ["approval_required"]), workflow: hooked })),
  ).toMatchObject({ hintKey: "chat.automationCard.review.hint.hook" });
  expect(card(inputs({ workflow: { ...hooked, webhooks_active: 0 } }), 0)).toMatchObject({
    hintKey: "chat.automationCard.review.hint.schedule",
  });
  expect(card(inputs({ workflow: hooked }), 1)).toMatchObject({
    hintKey: "chat.automationCard.review.hint.any",
  });
  expect(
    card(
      inputs({
        workflow: hooked,
        status: status(["approval_required"], ["paused"]),
      }),
      0,
    ),
  ).toMatchObject({ hintKey: "chat.automationCard.review.hint.schedule" });
  expect(
    card(
      inputs({
        workflow: hooked,
        status: status(["approval_required"], ["approval_required"]),
      }),
      0,
    ),
  ).toMatchObject({ hintKey: "chat.automationCard.review.hint.any" });
});
