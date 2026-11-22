import { describe, expect, test } from "bun:test";
import type { Bootstrap } from "@/api/client";
import { type TranslationKey, translate } from "@/lib/i18n";
import {
  aiAccessView,
  personalChanges,
  personalRefusal,
  profileStatus,
  workspaceAiStatus,
} from "./settings-personal";

const de = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate("de", key, values);

type AiAccess = Bootstrap["ai_access"];

const OWN_ACCESS: AiAccess = {
  configured: true,
  provider: "anthropic",
  model: null,
  own_key: true,
};
const OPERATOR_ACCESS: AiAccess = {
  configured: true,
  provider: "openai",
  model: null,
  own_key: false,
};
const NO_ACCESS: AiAccess = { configured: false, provider: null, model: null, own_key: false };

function session(name: string | null = "Mira Kessler", aiAccess: AiAccess = OWN_ACCESS) {
  return {
    principal: { display_name: name },
    tenant: { display_name: "Albrecht & Partner", timezone: "Europe/Berlin", language: "en" },
    ai_access: aiAccess,
  } as Pick<Bootstrap, "principal" | "tenant" | "ai_access">;
}

describe("drafts of the personal areas", () => {
  test("nothing typed, or typed back to the saved value, is no change", () => {
    expect(personalChanges(session(), {}).count).toBe(0);
    const same = personalChanges(session(), {
      name: " Mira Kessler ",
      workspaceName: "Albrecht & Partner",
      timezone: "Europe/Berlin",
      language: "en",
    });
    expect(same).toEqual({
      ai: null,
      profile: null,
      workspace: null,
      count: 0,
      invalid: [],
      areas: [],
    });
  });

  test("each changed value counts once and names its area", () => {
    const changes = personalChanges(session(), {
      name: "Mira K.",
      workspaceName: "Albrecht",
      timezone: "Europe/Vienna",
    });
    expect(changes.profile).toEqual({ display_name: "Mira K." });
    expect(changes.workspace).toEqual({ display_name: "Albrecht", timezone: "Europe/Vienna" });
    expect(changes.count).toBe(3);
    expect(changes.areas).toEqual(["profile", "workspace"]);
    expect(changes.invalid).toEqual([]);
  });

  test("only the time zone changes: the name is not sent", () => {
    expect(personalChanges(session(), { timezone: "UTC" }).workspace).toEqual({ timezone: "UTC" });
  });

  test("a changed workspace language is one workspace change", () => {
    const changes = personalChanges(session(), { language: "de" });
    expect(changes.workspace).toEqual({ language: "de" });
    expect(changes.count).toBe(1);
    expect(changes.areas).toEqual(["workspace"]);
  });

  test("an emptied name is a draft that cannot be saved", () => {
    const changes = personalChanges(session(), { name: " ", workspaceName: "" });
    expect(changes.invalid).toEqual(["name", "workspaceName"]);
    expect(changes.count).toBe(2);
    expect(personalChanges(session(null), { name: "" }).count).toBe(0);
  });
});

describe("drafts of a hosted workspace's AI access", () => {
  test("an opened but empty key field and the stored choices are no change", () => {
    expect(personalChanges(session(), { aiKey: "" }).ai).toBeNull();
    expect(personalChanges(session(), { aiProvider: "anthropic", aiModel: "" }).ai).toBeNull();
    expect(aiAccessView(OWN_ACCESS, {})).toEqual({
      stored: "anthropic",
      provider: "anthropic",
      model: "",
      keyStored: true,
      keyNeeded: false,
    });
  });

  test("a replaced key keeps provider and model and is sent trimmed", () => {
    const changes = personalChanges(
      session("Mira Kessler", { ...OWN_ACCESS, model: "claude-haiku-4-5" }),
      { aiKey: "  sk-ant-new  " },
    );
    expect(changes.ai).toEqual({
      llm_provider: "anthropic",
      llm_api_key: "sk-ant-new",
      llm_model: "claude-haiku-4-5",
    });
    expect(changes.count).toBe(1);
    expect(changes.areas).toEqual(["ai"]);
    expect(changes.invalid).toEqual([]);
  });

  test("a model alone is saved with the stored key", () => {
    const changes = personalChanges(session(), { aiModel: "claude-haiku-4-5" });
    expect(changes.ai).toEqual({ llm_provider: "anthropic", llm_model: "claude-haiku-4-5" });
    expect(
      personalChanges(session("Mira Kessler", { ...OWN_ACCESS, model: "claude-haiku-4-5" }), {
        aiModel: "",
      }).ai,
    ).toEqual({ llm_provider: "anthropic", llm_model: null });
  });

  test("another provider needs its own key and starts with its default model", () => {
    const stored = session("Mira Kessler", { ...OWN_ACCESS, model: "claude-haiku-4-5" });
    const switched = personalChanges(stored, { aiProvider: "openai", aiKey: "" });
    expect(switched.invalid).toEqual(["aiKey"]);
    expect(switched.ai).toEqual({ llm_provider: "openai", llm_model: null });
    expect(aiAccessView(stored.ai_access, { aiProvider: "openai" })).toMatchObject({
      provider: "openai",
      model: "",
      keyStored: false,
      keyNeeded: true,
    });
    const complete = personalChanges(stored, { aiProvider: "openai", aiKey: "sk-new" });
    expect(complete.invalid).toEqual([]);
    expect(complete.count).toBe(2);
    expect(complete.ai).toEqual({
      llm_provider: "openai",
      llm_api_key: "sk-new",
      llm_model: null,
    });
  });

  test("without an own key, the provider follows the operator's or starts with Anthropic", () => {
    expect(aiAccessView(OPERATOR_ACCESS, {})).toMatchObject({
      stored: null,
      provider: "openai",
      keyStored: false,
      keyNeeded: false,
    });
    expect(aiAccessView(NO_ACCESS, {}).provider).toBe("anthropic");
    expect(aiAccessView({ ...NO_ACCESS, provider: "bedrock" }, {}).provider).toBe("anthropic");
    expect(personalChanges(session("Mira Kessler", NO_ACCESS), {}).count).toBe(0);
    expect(personalChanges(session("Mira Kessler", NO_ACCESS), { aiKey: "sk-ant-1" }).ai).toEqual({
      llm_provider: "anthropic",
      llm_api_key: "sk-ant-1",
      llm_model: null,
    });
    expect(
      personalChanges(session("Mira Kessler", NO_ACCESS), { aiProvider: "gemini" }).invalid,
    ).toEqual(["aiKey"]);
  });
});

describe("the marks of the personal areas", () => {
  test("the AI access waits for the owner until a key is stored", () => {
    expect(workspaceAiStatus(session())).toBeNull();
    for (const access of [OPERATOR_ACCESS, NO_ACCESS])
      expect(workspaceAiStatus(session("Mira Kessler", access))).toBe("waiting");
  });

  test("a missing name is the one fact that marks the profile", () => {
    expect(profileStatus(session())).toBeNull();
    expect(profileStatus(session(null))).toBe("nameMissing");
  });
});

describe("a refused save of a personal area", () => {
  test("names who can change the workspace, or the time zone to pick again", () => {
    expect(personalRefusal({ status: 403, code: "workspace_admin_required" })).toBe(
      "settings.personal.forbidden",
    );
    expect(personalRefusal({ status: 422, code: "invalid_timezone" })).toBe(
      "settings.personal.timezoneRejected",
    );
    expect(personalRefusal({ status: 500, code: null })).toBeNull();
  });

  test("a rejected key reads the same as on the welcome page", () => {
    const rejected = personalRefusal({ status: 422, code: "llm_key_rejected" });
    expect(rejected).toBe("aiAccess.keyRejected");
    expect(rejected ? de(rejected) : "").toBe(
      "Der Anbieter hat diesen Schlüssel abgelehnt. Prüfe, ob er vollständig und noch gültig ist.",
    );
    expect(personalRefusal({ status: 502, code: "llm_provider_unreachable" })).toBe(
      "aiAccess.unreachable",
    );
    expect(personalRefusal({ status: 422, code: "llm_model_unavailable" })).toBe(
      "aiAccess.modelUnavailable",
    );
    expect(personalRefusal({ status: 409, code: "operator_change_pending" })).toBe(
      "settings.personal.operatorPending",
    );
  });

  test("a save that collided with another one asks to try again", () => {
    const collided = personalRefusal({ status: 409, code: "revision_conflict" });
    expect(collided).toBe("settings.personal.savedAtOnce");
    expect(collided ? de(collided) : "").toBe(
      "Gerade wurde gleichzeitig eine andere Einstellung gespeichert, deshalb wurde deine Änderung nicht gespeichert. Versuch es noch einmal.",
    );
  });
});
