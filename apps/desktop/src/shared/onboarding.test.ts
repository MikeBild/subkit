import { describe, expect, test } from "bun:test";
import {
  chooseWorkspace,
  completeStep,
  currentStep,
  NO_ONBOARDING,
  onboardingSteps,
  parseMemberships,
  startOnboarding,
  tenantSessionBody,
  workspaceFailed,
} from "./onboarding.ts";

const fresh = { notificationsAsked: false, diagnosticsAsked: false };
const answered = { notificationsAsked: true, diagnosticsAsked: true };
const two = [
  { tenantId: "t1", name: "Bild Consulting", role: "admin", owner: true },
  { tenantId: "t2", name: "Harmoniqs", role: "member", owner: false },
];

describe("first-run steps after sign-in", () => {
  test("a first run asks for workspace, notifications and diagnostics in that order", () => {
    expect(onboardingSteps(2, fresh)).toEqual(["workspace", "notifications", "diagnostics"]);
  });

  test("a single workspace skips the choice", () => {
    expect(onboardingSteps(1, fresh)).toEqual(["notifications", "diagnostics"]);
    expect(onboardingSteps(0, fresh)).toEqual(["notifications", "diagnostics"]);
  });

  test("a later sign-in never asks the answered questions again", () => {
    expect(onboardingSteps(1, answered)).toEqual([]);
    expect(onboardingSteps(3, answered)).toEqual(["workspace"]);
  });

  test("steps finish one after the other and end at the device", () => {
    let flow = startOnboarding(two, fresh);
    expect(currentStep(flow)).toBe("workspace");
    flow = chooseWorkspace(flow, "t2");
    expect(flow.chosen).toBe("t2");
    expect(currentStep(flow)).toBe("notifications");
    flow = completeStep(flow, "notifications");
    flow = completeStep(flow, "diagnostics");
    expect(currentStep(flow)).toBeNull();
    expect(completeStep(flow, "diagnostics")).toBe(flow);
  });

  test("after a failed switch the person can stay in the current workspace", () => {
    const failed = workspaceFailed(startOnboarding(two, fresh));
    const kept = completeStep(failed, "workspace");
    expect(kept.chosen).toBeNull();
    expect(currentStep(kept)).toBe("notifications");
  });

  test("an unknown workspace changes nothing, a failed switch is remembered until the next step", () => {
    const flow = startOnboarding(two, fresh);
    expect(chooseWorkspace(flow, "nope")).toBe(flow);
    const failed = workspaceFailed(flow);
    expect(failed.failed).toBe(true);
    expect(chooseWorkspace(failed, "t1").failed).toBe(false);
    expect(currentStep(NO_ONBOARDING)).toBeNull();
  });
});

describe("memberships from the server", () => {
  test("reads name, role and owner, drops broken entries", () => {
    expect(
      parseMemberships({
        items: [
          { tenant_id: "t1", display_name: "Bild Consulting", role: "admin", is_owner: true },
          { tenant_id: "", display_name: "x" },
          { display_name: "no id" },
          "junk",
        ],
      }),
    ).toEqual([{ tenantId: "t1", name: "Bild Consulting", role: "admin", owner: true }]);
    expect(parseMemberships(null)).toEqual([]);
    expect(tenantSessionBody("t1")).toBe('{"tenant_id":"t1"}');
  });
});
