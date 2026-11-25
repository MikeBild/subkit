import { describe, expect, test } from "bun:test";
import {
  withLatestPreview,
  withWorkflowDraft,
  withWorkflowInspection,
  withWorkflowValidation,
} from "./authoring-state/index.ts";
import {
  type HandoffKind,
  handoffSummary,
  inferReplyLocale,
  type SavePreviewEvidence,
  saveVerificationEvidence,
  turnHandoff,
} from "./handoff-summary.ts";
import type { DraftDocument } from "./types.ts";

const PROD_PROMPT =
  "Bereite diesen Ablauf für den automatischen Betrieb vor. Prüfe den bestehenden Zeitplan und die Ziele; ändere sie nur auf meinen Wunsch. Übernimm die erlaubten Prüfungen selbst und speichere die vorbereiteten Änderungen, soweit erlaubt. Nicht aktivieren, keine Live-Wirkungen freigeben oder ausführen. Erkläre Ergebnis und nächsten Schritt kurz.";

const PREVIEWS: SavePreviewEvidence[] = [
  "passed",
  "passed_metadata",
  "passed_schema_only",
  "failed",
  "skipped_by_user",
  "missing",
];
const OTHER_KINDS: HandoffKind[] = ["confirm", "choice", "input", "answer", "review"];

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function expectBrief(text: string): void {
  expect(text.trim().length).toBeGreaterThan(0);
  expect(sentences(text).length).toBeLessThanOrEqual(2);
  expect(text).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
  expect(text).not.toContain("?");
  expect(text).not.toMatch(/https?:\/\//);
}

function draftFor(privacy: "sensitive" | null): DraftDocument {
  const base: DraftDocument = {
    mode: "workflow_authoring",
    workflow: {
      name: "briefing",
      steps: [{ id: "s1", kind: "transform", language: "javascript", expression: "return 1;" }],
      ...(privacy ? { execution_privacy: privacy } : {}),
    },
  } as DraftDocument;
  return withWorkflowValidation(withWorkflowInspection(base), true, "valid");
}

describe("handoff summary", () => {
  for (const locale of ["de", "en"] as const) {
    for (const preview of PREVIEWS) {
      test(`${locale} save confirmation with preview ${preview} states result and next step`, () => {
        const text = handoffSummary({ locale, handoff: "save_confirm", evidence: { preview } });
        expectBrief(text);
        expect(text).toMatch(locale === "de" ? /Nächster Schritt/ : /Next step/);
      });
    }
    for (const handoff of OTHER_KINDS) {
      test(`${locale} ${handoff} hand-off states result and next step`, () => {
        const text = handoffSummary({ locale, handoff });
        expectBrief(text);
        expect(text).toMatch(locale === "de" ? /Nächster Schritt/ : /Next step/);
      });
    }
  }

  test("a text question points to the message box because it has no card", () => {
    const pending = turnHandoff({ tool_name: "ask_user_text" }, false);
    expect(pending?.handoff).toBe("answer");
    for (const locale of ["de", "en"] as const) {
      const text = handoffSummary({ locale, handoff: "answer" });
      expect(text).not.toMatch(/Karte|card/);
      expect(text).toMatch(locale === "de" ? /Eingabefeld/ : /message box/);
    }
  });

  test("a form keeps pointing to its card", () => {
    expect(turnHandoff({ tool_name: "ask_user_form" }, false)?.handoff).toBe("input");
  });

  test("German sensitive save reports the confidential test run and that nothing is activated", () => {
    const text = handoffSummary({
      locale: "de",
      handoff: "save_confirm",
      evidence: { preview: "passed_metadata" },
    });
    expect(text).toContain("Testlauf ohne Wirkung war erfolgreich");
    expect(text).toContain("vertraulich");
    expect(text).toContain("aktiviert wird dabei nichts");
  });

  test("the reply locale follows the PROD prompt language", () => {
    expect(inferReplyLocale(PROD_PROMPT)).toBe("de");
    expect(
      inferReplyLocale("Prepare this workflow and save the changes, do not activate it."),
    ).toBe("en");
    expect(inferReplyLocale(null)).toBe("de");
  });
});

describe("save verification evidence", () => {
  test("a sensitive draft needs its metadata test run", () => {
    expect(saveVerificationEvidence(draftFor("sensitive"), false).preview).toBe("missing");
    const previewed = withLatestPreview(draftFor("sensitive"), {
      ok: true,
      summary: "Sensitive test run succeeded",
      warnings: [],
    });
    expect(saveVerificationEvidence(previewed, false)).toEqual({
      preview: "passed_metadata",
      summary: "Sensitive test run succeeded",
      draft_fingerprint: expect.any(String),
    });
  });

  test("a fresh green preview passes", () => {
    const draft = withLatestPreview(draftFor(null), { ok: true, summary: "3 rows", warnings: [] });
    expect(saveVerificationEvidence(draft, false)).toEqual({
      preview: "passed",
      summary: "3 rows",
      draft_fingerprint: expect.any(String),
    });
  });

  test("a green preview of an earlier draft does not count for the changed draft", () => {
    const previewed = withLatestPreview(draftFor(null), { ok: true, summary: "ok", warnings: [] });
    const changed = withWorkflowDraft(previewed, {
      ...(previewed.workflow as NonNullable<DraftDocument["workflow"]>),
      steps: [{ id: "s1", kind: "transform", language: "javascript", expression: "return 2;" }],
    });
    expect(saveVerificationEvidence(changed, false).preview).toBe("missing");
  });

  test("a failed preview is reported as failed", () => {
    const draft = withLatestPreview(draftFor(null), { ok: false, summary: "boom", warnings: [] });
    expect(saveVerificationEvidence(draft, false).preview).toBe("failed");
  });

  test("a missing preview is skipped only when the user forbade test runs", () => {
    expect(saveVerificationEvidence(draftFor(null), false).preview).toBe("missing");
    expect(saveVerificationEvidence(draftFor(null), true).preview).toBe("skipped_by_user");
  });
});
