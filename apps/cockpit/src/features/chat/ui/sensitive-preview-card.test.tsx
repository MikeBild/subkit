import { expect, test } from "bun:test";
import { render } from "@/components/cockpit/patterns/test-utils";
import type { ChatSensitivePreview } from "../model/preview-cards";
import { ChatSensitivePreviewCard } from "./sensitive-preview-card";

const preview: ChatSensitivePreview = {
  passed: true,
  stage: "schema_only",
  steps: 3,
  expressions: 4,
  compileErrors: 0,
  requestsHeld: true,
  saveRequired: false,
  workflow: { id: "wf-1", label: "upraft-auth-notify" },
};

const tag = (html: string, testId: string) =>
  html.match(new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? "";

test("the German card shows all three stages with the structure stage active", () => {
  const html = render(<ChatSensitivePreviewCard preview={preview} testId="p" />, "de");
  expect(html).toContain("Vorschau eines sensiblen Workflows");
  expect(html).toContain("Nur Struktur geprüft");
  expect(html).toContain("Mit geschwärzten Beispieldaten");
  expect(html).toContain("Von dir im Cockpit geprüft");
  expect(tag(html, "p-stage-schema_only")).toContain('aria-current="step"');
  expect(tag(html, "p-stage-redacted_fixture")).not.toContain("aria-current");
  expect(tag(html, "p-stage-person_verified")).not.toContain("aria-current");
  expect(html).toContain("Struktur geprüft, Inhalte nicht geprüft.");
  expect(html).toContain("Definition gültig, 3 Schritte");
  expect(html).toContain("4 Ausdrücke kompilieren");
  expect(html).toContain("Keine Anfrage gesendet, keine Daten gelesen");
});

test("the primary action opens the run dialog on the workflow page and the @ reference links to it", () => {
  const html = render(<ChatSensitivePreviewCard preview={preview} testId="p" />, "de");
  const verify = tag(html, "p-verify");
  expect(verify).toContain('href="/cockpit/workflows/wf-1#workflow-run"');
  expect(verify).toContain("w-full");
  expect(verify).toContain("sm:w-auto");
  expect(html).toContain("Im Cockpit selbst prüfen");
  expect(tag(html, "p-workflow")).toContain('href="/cockpit/workflows/wf-1"');
  expect(html).toContain("@upraft-auth-notify");
  expect(html).not.toContain("Ohne Run speichern");
  expect(html).toContain("Inhalte prüfst nur du, mit echten Daten im Cockpit.");
});

test("a draft that still needs saving keeps the @ reference but offers no run of the older saved version", () => {
  const html = render(
    <ChatSensitivePreviewCard preview={{ ...preview, saveRequired: true }} testId="p" />,
    "de",
  );
  expect(tag(html, "p-workflow")).toContain('href="/cockpit/workflows/wf-1"');
  expect(html).not.toContain("p-verify");
  expect(html).toContain("Nach dem Speichern prüfst du die Inhalte selbst im Cockpit.");
});

test("a failed check names the compile errors with a warning and an unsaved draft has no Cockpit action", () => {
  const html = render(
    <ChatSensitivePreviewCard
      preview={{ ...preview, passed: false, compileErrors: 1, requestsHeld: false, workflow: null }}
      testId="p"
    />,
    "en",
  );
  expect(html).toContain("Structure check not passed.");
  expect(html).toContain("1 expression does not compile");
  expect(tag(html, "p-check-expressions")).toContain('data-ok="false"');
  expect(html).not.toContain("p-check-held");
  expect(html).not.toContain("p-verify");
  expect(html).not.toContain("p-workflow");
  expect(html).toContain("Once it is saved, you check the content yourself in the Cockpit.");
});

test("a draft saved later in the conversation switches to its saved state with the Cockpit check", () => {
  const html = render(
    <ChatSensitivePreviewCard
      preview={{ ...preview, saveRequired: true, workflow: null }}
      saved={{ id: "wf-7", label: "weekly-report" }}
      testId="p"
    />,
    "de",
  );
  const verify = tag(html, "p-verify");
  expect(verify).toContain('href="/cockpit/workflows/wf-7#workflow-run"');
  expect(verify).toContain("w-full");
  expect(verify).toContain("sm:w-auto");
  expect(html).toContain("Im Cockpit selbst prüfen");
  expect(tag(html, "p-workflow")).toContain('href="/cockpit/workflows/wf-7"');
  expect(html).toContain("@weekly-report");
  expect(html).toContain("Inhalte prüfst nur du, mit echten Daten im Cockpit.");
  expect(html).not.toContain("Nach dem Speichern");
});

test("the English saved state names the check, and a failed check stays without action", () => {
  const saved = { id: "wf-7", label: "weekly-report" };
  const html = render(
    <ChatSensitivePreviewCard
      preview={{ ...preview, saveRequired: true }}
      saved={saved}
      testId="p"
    />,
    "en",
  );
  expect(html).toContain("Check it yourself in the Cockpit");
  expect(html).toContain("Only you check the content, with real data in the Cockpit.");
  const failed = render(
    <ChatSensitivePreviewCard preview={{ ...preview, passed: false }} saved={saved} testId="p" />,
    "en",
  );
  expect(failed).not.toContain("p-verify");
});
