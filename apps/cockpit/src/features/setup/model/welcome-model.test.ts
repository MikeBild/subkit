import { describe, expect, test } from "bun:test";
import { translate } from "@/lib/i18n";
import {
  keyAfterSubmit,
  suggestedName,
  type WelcomeValues,
  welcomeErrors,
  welcomeFailure,
  welcomeFailureKey,
  welcomeFailurePlace,
  welcomeRequest,
  workspaceSuggestion,
} from "./welcome-model";

const FILLED: WelcomeValues = {
  name: "Mira",
  workspace: "Albrecht & Partner",
  timezone: "Europe/Berlin",
  provider: "anthropic",
  key: "sk-ant-fixture",
};

const template = (name: string) => translate("de", "welcome.workspaceDefault", { name });

describe("welcome prefill", () => {
  test("the name comes from the sign-in, else from the address", () => {
    expect(
      suggestedName({ email: "mira.kessler@example.com", suggested_display_name: "Mira K." }),
    ).toBe("Mira K.");
    expect(suggestedName({ email: "mira.kessler@example.com", suggested_display_name: null })).toBe(
      "Mira Kessler",
    );
    expect(suggestedName({ email: "mira@example.com", suggested_display_name: "  " })).toBe("Mira");
  });

  test("the workspace name follows the name and stays empty without one", () => {
    expect(workspaceSuggestion("Mira Kessler", template)).toBe("Arbeitsbereich von Mira Kessler");
    expect(workspaceSuggestion("  ", template)).toBe("");
    expect(workspaceSuggestion("x".repeat(200), template).length).toBe(120);
  });
});

describe("welcome validation", () => {
  test("every field is required and names what is missing", () => {
    expect(
      welcomeErrors({ name: " ", workspace: "", timezone: "", provider: "openai", key: "  " }),
    ).toEqual({
      name: "welcome.nameError",
      workspace: "welcome.workspaceError",
      timezone: "welcome.timezoneError",
      key: "welcome.ai.keyError",
    });
    expect(welcomeErrors(FILLED)).toEqual({});
    expect(translate("de", "welcome.ai.keyError")).toBe("Gib deinen API-Schlüssel ein.");
  });

  test("the request carries the trimmed values and the chosen provider with its key", () => {
    expect(
      welcomeRequest({ ...FILLED, name: " Mira ", provider: "gemini", key: " AIza-1 " }),
    ).toEqual({
      display_name: "Mira",
      workspace_name: "Albrecht & Partner",
      timezone: "Europe/Berlin",
      llm_provider: "gemini",
      llm_api_key: "AIza-1",
    });
  });
});

describe("welcome refusals", () => {
  test("an expired registration asks for a new sign-in", () => {
    expect(welcomeFailure({ status: 401, code: "registration_pending_required" })).toBe("expired");
  });

  test("closed, limited and unavailable registration read as one sentence", () => {
    for (const refusal of [
      { status: 403, code: "registration_closed" },
      { status: 429, code: "registration_rate_limited" },
      { status: 503, code: "registration_policy_unavailable" },
    ]) {
      expect(welcomeFailure(refusal)).toBe("unavailable");
    }
    expect(translate("de", welcomeFailureKey("unavailable"))).toBe(
      "Gerade können keine neuen Arbeitsbereiche angelegt werden. Versuch es später noch einmal.",
    );
  });

  test("the key stays in the form after a refusal and leaves it once the workspace exists", () => {
    expect(keyAfterSubmit("sk-ant-fixture", "refused")).toBe("sk-ant-fixture");
    expect(keyAfterSubmit("sk-ant-fixture", "created")).toBe("");
  });

  test("a rejected key is named next to the key field", () => {
    const failure = welcomeFailure({ status: 422, code: "llm_key_rejected" });
    expect(failure).toBe("keyRejected");
    expect(welcomeFailurePlace(failure)).toBe("key");
    expect(translate("de", welcomeFailureKey(failure))).toBe(
      "Der Anbieter hat diesen Schlüssel abgelehnt. Prüfe, ob er vollständig und noch gültig ist.",
    );
    expect(translate("en", welcomeFailureKey(failure))).toBe(
      "The provider rejected this key. Check that it is complete and still valid.",
    );
  });

  test("an unreachable provider and too many attempts read as an alert above the button", () => {
    const unreachable = welcomeFailure({ status: 502, code: "llm_provider_unreachable" });
    expect(unreachable).toBe("providerUnreachable");
    expect(welcomeFailurePlace(unreachable)).toBe("alert");
    expect(translate("de", welcomeFailureKey(unreachable))).toBe(
      "Der Anbieter antwortet gerade nicht. Versuch es in einem Moment noch einmal.",
    );
    const limited = welcomeFailure({ status: 429, code: "llm_probe_rate_limited" });
    expect(limited).toBe("tooManyAttempts");
    expect(welcomeFailurePlace(limited)).toBe("alert");
    expect(translate("de", welcomeFailureKey(limited))).toBe(
      "Zu viele Versuche. Melde dich neu an und versuch es noch einmal.",
    );
  });

  test("a workspace whose key was not saved yet asks for the same submit again", () => {
    const failure = welcomeFailure({ status: 503, code: "llm_access_not_stored" });
    expect(failure).toBe("notStored");
    expect(translate("de", welcomeFailureKey(failure))).toContain("„Loslegen“");
    expect(welcomeFailure({ status: 422, code: "llm_provider_unavailable" })).toBe(
      "providerUnavailable",
    );
    expect(welcomeFailurePlace("timezone")).toBe("timezone");
  });

  test("a rejected time zone points at its field, a stale form is retried, the rest is generic", () => {
    expect(welcomeFailure({ status: 422, code: "invalid_timezone" })).toBe("timezone");
    expect(welcomeFailure({ status: 403, code: "registration_csrf_rejected" })).toBe("stale");
    expect(welcomeFailure({ status: 400, code: "bad_request" })).toBe("generic");
    expect(welcomeFailure({ status: 0, code: null })).toBe("generic");
    expect(translate("de", welcomeFailureKey("generic"))).toBe(
      "Das hat nicht geklappt. Versuch es noch einmal.",
    );
  });
});
