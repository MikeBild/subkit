import { describe, expect, test } from "bun:test";
import { auditActionLabel } from "@/lib/audit-model";
import { translate } from "./i18n";
import {
  confirmedSpec,
  specCanConfirm,
  specForm,
  specFormChanged,
  specFormValid,
  specFromForm,
  specSaveBody,
  specState,
  type WorkflowSpec,
} from "./workflow-spec";

const chatSpec: WorkflowSpec = {
  goal: "Mail the daily digest",
  inputs: [{ name: "day", description: "Day to report" }],
  outputs: [{ name: "digest" }],
  delivery: { channel: "email", destination: "team@example.com" },
  conventions_applied: [{ note: "Plain text only" }],
  evidence: [{ source: "connector", locator: "inbox" }],
  open_questions: ["Which time zone?"],
  origin: "chat",
};

describe("workflow spec state", () => {
  test("a missing spec is not stated and cannot be confirmed", () => {
    expect(specState(null)).toBe("missing");
    expect(specCanConfirm(null)).toBe(false);
  });

  test("only a person's spec with a goal counts as confirmed", () => {
    expect(specState(chatSpec)).toBe("unconfirmed");
    expect(specState({ ...chatSpec, origin: "derived" })).toBe("unconfirmed");
    expect(specState({ ...chatSpec, origin: "person" })).toBe("confirmed");
    expect(specState({ ...chatSpec, origin: "person", goal: null })).toBe("unconfirmed");
  });

  test("confirmation is offered for a chat spec with a goal and not for a confirmed one", () => {
    expect(specCanConfirm(chatSpec)).toBe(true);
    expect(specCanConfirm({ ...chatSpec, goal: null })).toBe(false);
    expect(specCanConfirm({ ...chatSpec, origin: "person" })).toBe(false);
  });

  test("confirming changes only the origin", () => {
    expect(confirmedSpec(chatSpec)).toEqual({ ...chatSpec, origin: "person" });
  });
});

describe("workflow spec form", () => {
  test("an untouched form reproduces the stored spec", () => {
    expect(specFromForm(chatSpec, specForm(chatSpec))).toEqual(chatSpec);
    expect(specFormChanged(chatSpec, specForm(chatSpec))).toBe(false);
  });

  test("an edit keeps the origin, conventions and evidence it does not show", () => {
    const next = specFromForm(chatSpec, {
      ...specForm(chatSpec),
      goal: "  Mail the weekly digest ",
      inputs: "week: Week to report\nregion",
      questions: "Which time zone?\n\n Which language? ",
    });
    expect(next.goal).toBe("Mail the weekly digest");
    expect(next.inputs).toEqual([
      { name: "week", description: "Week to report" },
      { name: "region" },
    ]);
    expect(next.open_questions).toEqual(["Which time zone?", "Which language?"]);
    expect(next.origin).toBe("chat");
    expect(next.conventions_applied).toEqual(chatSpec.conventions_applied);
    expect(next.evidence).toEqual(chatSpec.evidence);
  });

  test("an empty channel drops the delivery and an empty goal becomes unknown", () => {
    const next = specFromForm(chatSpec, { ...specForm(chatSpec), channel: "", goal: "" });
    expect(next.delivery).toBeNull();
    expect(next.goal).toBeNull();
  });

  test("a first spec written in the form is stated by a person", () => {
    const next = specFromForm(null, { ...specForm(null), goal: "Archive invoices" });
    expect(next.origin).toBe("person");
    expect(next.goal).toBe("Archive invoices");
  });

  test("entries beyond the schema limits are refused before sending", () => {
    expect(specFormValid({ ...specForm(null), goal: "x".repeat(2001) })).toBe(false);
    expect(specFormValid({ ...specForm(null), questions: "q\n".repeat(51) })).toBe(false);
    expect(specFormValid({ ...specForm(null), goal: "x".repeat(2000) })).toBe(true);
  });
});

describe("workflow spec save", () => {
  test("a spec-only save sends the draft definition with the draft's concurrency tokens", () => {
    const draft = {
      workflow_id: "w",
      version_id: "v-draft",
      version: 3,
      digest: "d",
      current_version_id: "v-current",
      definition: { id: "wf" },
      spec: chatSpec,
    } as unknown as Parameters<typeof specSaveBody>[0];
    expect(specSaveBody(draft, confirmedSpec(chatSpec))).toEqual({
      definition: draft.definition,
      expected_draft_version_id: "v-draft",
      expected_current_version_id: "v-current",
      spec: { ...chatSpec, origin: "person" },
    });
  });
});

describe("workflow spec audit label", () => {
  test("the spec update is named in both languages", () => {
    const label = auditActionLabel("draft.spec.updated");
    expect(label.kind).toBe("named");
    if (label.kind !== "named") return;
    expect(translate("en", label.key)).toBe("Purpose and acceptance updated");
    expect(translate("de", label.key)).toBe("Zweck und Abnahme geändert");
  });
});
