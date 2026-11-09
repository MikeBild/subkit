import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  AUTOMATION_STATE_KEYS,
  type AutomationInputs,
  automationActionKey,
  automationCard,
  automationNeedsMoreApprovals,
  automationState,
  carryOverChoice,
  EXTEND_BELOW_RUN_SHARE,
  EXTEND_WITHIN_DAYS,
} from "@/lib/automation-state";
import { recommendedAutomationEnvironment } from "@/lib/core/automation-presentation";
import { CATALOGS } from "@/lib/i18n";
import {
  ACTIVE,
  authority,
  DRAFT,
  hooked,
  inputs,
  rows,
  schedule,
  status,
} from "./automation-state-fixtures.ts";

describe("a hook the reader may not list", () => {
  test("authorized development schedules do not answer for it", () => {
    const input = inputs({
      workflow: hooked,
      schedules: [schedule({ execution_mode: "dev" })],
      status: rows([["authorized", "dev"]]),
    });
    const none = automationState(input);
    expect(none.state).toBe("grant");
    expect(none.environment).toBe("prod");
    const listed = automationState({ ...input, authorities: [authority()] });
    expect(listed.state).toBe("unknown");
    expect(listed.secondaryAction).toEqual({ kind: "view" });
  });

  test("an authorized production schedule answers for it: same version, same approval", () => {
    const state = automationState(
      inputs({
        workflow: hooked,
        status: rows([["authorized", "prod"]]),
        authorities: [authority()],
      }),
    );
    expect(state.state).toBe("approved");
  });
});

describe("the approval in force can lie behind the first page", () => {
  test("approved without its approval in sight asks for more", () => {
    const state = automationState(inputs({ status: status(["authorized"]), authorities: [] }));
    expect(state.state).toBe("approved");
    expect(state.grant).toBeNull();
    expect(automationNeedsMoreApprovals(state, true)).toBe(true);
    expect(automationNeedsMoreApprovals(state, false)).toBe(false);
  });

  test("an approval in sight, or any other state, asks for nothing", () => {
    const approved = automationState(
      inputs({ status: status(["authorized"]), authorities: [authority()] }),
    );
    expect(automationNeedsMoreApprovals(approved, true)).toBe(false);
    expect(automationNeedsMoreApprovals(automationState(inputs()), true)).toBe(false);
  });
});

describe("a stopped hook cannot be resumed from here", () => {
  test("a hook-only workflow that is paused offers no action", () => {
    const state = automationState(
      inputs({ schedules: [], status: status([], ["paused"]), workflow: hooked }),
    );
    expect(state.state).toBe("paused");
    expect(state.primaryAction).toBeNull();
    expect(state.pendingEnvironments).toEqual([]);
  });
});

describe("the chat's review card", () => {
  const hookOnly = { schedules: [], workflow: hooked };

  test("one environment gives one button, named for the page's own step", () => {
    const card = automationCard(automationState(inputs()), 0);
    expect(card.environments).toEqual(["prod"]);
    expect(card.actionKey).toBe(automationActionKey({ kind: "grant" }));
    const apply = automationCard(
      automationState(
        inputs({
          workflow: {
            lifecycle: "active",
            current_version_id: ACTIVE,
            draft_version_id: DRAFT,
            current_version: 9,
          },
        }),
      ),
      0,
    );
    expect(apply.environments).toEqual(["prod"]);
    expect(apply.actionKey).toBe(automationActionKey({ kind: "apply" }));
    expect(apply.hintKey).toBe("chat.automationCard.apply.hint");
  });

  test("two environments give two buttons, production first", () => {
    const card = automationCard(
      automationState(
        inputs({
          status: rows([
            ["approval_required", "dev"],
            ["approval_required", "prod"],
          ]),
        }),
      ),
      0,
    );
    expect(card.environments).toEqual(["prod", "dev"]);
  });

  test("a hook-started workflow only ever offers production", () => {
    const cards = [
      inputs({ ...hookOnly, status: status([], ["approval_required"]) }),
      inputs({ ...hookOnly, status: null }),
      inputs({
        ...hookOnly,
        status: status([], ["approval_required"]),
        workflow: { ...hooked, draft_version_id: DRAFT },
      }),
    ].map((input) => automationCard(automationState(input), 1));
    for (const card of cards) expect(card.environments).toEqual(["prod"]);
  });

  test("the hint names what an approval allows: scheduled runs, webhook calls, or both", () => {
    const hint = (input: Partial<AutomationInputs>, webhooks: number) =>
      automationCard(automationState(inputs(input)), webhooks).hintKey;
    expect(hint({}, 0)).toBe("chat.automationCard.review.hint.schedule");
    expect(hint({ ...hookOnly, status: status([], ["approval_required"]) }, 1)).toBe(
      "chat.automationCard.review.hint.hook",
    );
    expect(
      hint({ workflow: hooked, status: status(["approval_required"], ["approval_required"]) }, 1),
    ).toBe("chat.automationCard.review.hint.any");
    expect(hint({ ...hookOnly, status: null }, 1)).toBe("chat.automationCard.review.hint.hook");
  });

  test("an approved workflow offers no button", () => {
    const card = automationCard(
      automationState(inputs({ status: status(["authorized"]), authorities: [authority()] })),
      0,
    );
    expect(card).toMatchObject({ act: "none", environments: [] });
    expect(card.titleKey).toBe("chat.automationCard.authorized.title");
    expect(card.hintKey).toBe("chat.automationCard.authorized.hint");
  });

  test("repair opens the review under its own words", () => {
    const repair = automationCard(
      automationState(inputs({ status: status(["repair_required"]), diagnosis: null })),
      0,
    );
    expect(repair).toMatchObject({ act: "review", environments: ["prod"] });
    expect(repair.actionKey).toBe("chat.automationCard.repair.action");
  });

  test("on request: the page's calm state, and nothing to press", () => {
    const manual = automationCard(
      automationState(inputs({ schedules: [], status: status(), authorities: [] })),
      0,
    );
    expect(manual).toMatchObject({ act: "none", environments: [] });
    expect(manual.titleKey).toBe(AUTOMATION_STATE_KEYS.manual);
    expect(manual.hintKey).toBe("automation.headline.manual");
    const inactive = automationCard(
      automationState(
        inputs({
          workflow: {
            lifecycle: "archived",
            current_version_id: ACTIVE,
            draft_version_id: ACTIVE,
            current_version: 9,
          },
        }),
      ),
      0,
    );
    expect(inactive).toMatchObject({ act: "none", hintKey: "automation.headline.inactive" });
  });

  test("paused: resuming is the act, as on the page — or a line, for a stopped hook", () => {
    const paused = automationCard(
      automationState(
        inputs({ schedules: [schedule({ paused: true })], status: status(["paused"]) }),
      ),
      0,
    );
    expect(paused).toMatchObject({ act: "resume", environments: [] });
    expect(paused.titleKey).toBe(AUTOMATION_STATE_KEYS.paused);
    expect(paused.actionKey).toBe(automationActionKey({ kind: "resume", scheduleIds: [] }));
    const hookOff = automationCard(
      automationState(inputs({ schedules: [], status: status([], ["paused"]), workflow: hooked })),
      0,
    );
    expect(hookOff).toMatchObject({ act: "none", hintKey: "automation.hookOff" });
  });

  test("not verified: reading again is the act, never the approval dialog", () => {
    const unknown = automationCard(automationState(inputs({ authorities: null })), 0);
    expect(unknown).toMatchObject({ act: "recheck", environments: [] });
    expect(unknown.actionKey).toBe("automation.action.recheck");
    expect(unknown.hintKey).toBe("automation.headline.unknown");
  });

  test("only a pending decision opens the approval", () => {
    const acts = (
      [
        [inputs(), "review"],
        [inputs({ status: status(["authorized"]), authorities: [authority()] }), "none"],
        [inputs({ schedules: [], status: status() }), "none"],
        [inputs({ authorities: null }), "recheck"],
      ] as const
    ).map(([input, act]) => [automationCard(automationState(input), 0).act, act]);
    for (const [actual, expected] of acts) expect(actual).toBe(expected);
  });

  test("every word of the card exists in both catalogs", () => {
    const keys = [
      "chat.automationCard.review.hint.schedule",
      "chat.automationCard.review.hint.hook",
      "chat.automationCard.review.hint.any",
      "chat.automationCard.review.prod",
      "chat.automationCard.review.dev",
      "chat.automationCard.repair.action",
    ] as const;
    for (const catalog of Object.values(CATALOGS))
      for (const key of keys) expect(catalog[key], key).toBeTruthy();
    for (const key of keys.slice(0, 3)) {
      expect(CATALOGS.de[key]).toStartWith("Öffne die Prüfung");
      expect(CATALOGS.de[key]).not.toContain("unten");
    }
    expect(CATALOGS.de["chat.automationCard.review.hint.schedule"]).toContain("geplante Läufe");
    expect(CATALOGS.de["chat.automationCard.review.hint.hook"]).toContain(
      "eingehende Webhook-Aufrufe",
    );
  });
});

describe("the extension thresholds are the engine's", () => {
  test("the attention list and the panel warn on the same numbers", () => {
    const engine = readFileSync(
      new URL("../../../engine/src/workflows/authority-extension.ts", import.meta.url).pathname,
      "utf8",
    );
    const constant = (name: string) => {
      const match = new RegExp(`export const ${name} = ([0-9.]+);`).exec(engine);
      if (!match?.[1]) throw new Error(`${name} not found in the engine`);
      return Number(match[1]);
    };
    expect(EXTEND_WITHIN_DAYS).toBe(constant("AUTHORITY_EXTEND_WITHIN_DAYS"));
    expect(EXTEND_BELOW_RUN_SHARE).toBe(constant("AUTHORITY_EXTEND_BELOW_RUN_SHARE"));
  });
});

describe("a version stored in an earlier format", () => {
  const invalid = { ...hooked, invalid: true };

  test("is its own state, whatever is approved or would start it", () => {
    const state = automationState(
      inputs({ workflow: invalid, status: status(["authorized"]), authorities: [authority()] }),
    );
    expect(state.state).toBe("invalid");
    expect(state.primaryAction).toEqual({ kind: "repair", via: "chat", stepId: null });
    expect(state.pendingEnvironments).toEqual([]);
    expect(automationState(inputs({ workflow: invalid })).state).toBe("invalid");
    expect(
      automationState(
        inputs({
          workflow: invalid,
          schedules: [schedule({ paused: true })],
          status: status(["paused"]),
        }),
      ).state,
    ).toBe("invalid");
  });

  test("a saved change is the way out, and leads", () => {
    const state = automationState(inputs({ workflow: { ...invalid, draft_version_id: DRAFT } }));
    expect(state.state).toBe("apply");
  });

  test("the chat card says the state and offers no approval", () => {
    const card = automationCard(automationState(inputs({ workflow: invalid })), 1);
    expect(card).toMatchObject({ act: "none", environments: [] });
    expect(card.titleKey).toBe(AUTOMATION_STATE_KEYS.invalid);
    expect(CATALOGS.de[card.hintKey]).toContain("älteren Format");
    expect(CATALOGS.en[card.hintKey]).toContain("earlier format");
    expect(CATALOGS.de[AUTOMATION_STATE_KEYS.invalid]).toBe("Altes Format");
  });
});

describe("carry-over choice", () => {
  const preview = (
    overrides: Partial<Parameters<typeof carryOverChoice>[0] & object> = {},
  ): Parameters<typeof carryOverChoice>[0] => ({
    approval_carries_over: true,
    eligible_for_repeated_runs: true,
    execution_shape: {
      requests: [{ request_review_truncated: false, opaque_payload_omitted: false }],
    },
    ...overrides,
  });

  test("a saved change within the approved boundary is adopted in one click", () => {
    expect(carryOverChoice(preview(), true)).toBe("adopt");
  });

  test("a grown boundary goes through the review", () => {
    expect(carryOverChoice(preview({ approval_carries_over: false }), true)).toBe("review");
  });

  test("without a saved change there is nothing to adopt", () => {
    expect(carryOverChoice(preview(), false)).toBe("review");
  });

  test("an unsupported or incomplete review never adopts", () => {
    expect(carryOverChoice(preview({ eligible_for_repeated_runs: false }), true)).toBe("review");
    expect(
      carryOverChoice(
        preview({
          execution_shape: {
            requests: [{ request_review_truncated: true, opaque_payload_omitted: false }],
          },
        }),
        true,
      ),
    ).toBe("review");
    expect(
      carryOverChoice(
        preview({
          execution_shape: {
            requests: [{ request_review_truncated: false, opaque_payload_omitted: true }],
          },
        }),
        true,
      ),
    ).toBe("review");
  });

  test("a missing preview goes through the review", () => {
    expect(carryOverChoice(null, true)).toBe("review");
  });
});
test("automation presentation core reads only a declared recommendation", () => {
  expect(recommendedAutomationEnvironment(null)).toBeNull();
  expect(
    recommendedAutomationEnvironment({ recommended_environment: { environment: "prod" } }),
  ).toBe("prod");
});
