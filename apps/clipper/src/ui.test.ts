import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  contentSummary,
  copy,
  generatedSectionSelection,
  intakeItemReviewParams,
  intakeItemReviewPrompt,
  intakeReviewPrompt,
  isCapturablePageUrl,
  isSourceWindow,
  previewBlocks,
  previewText,
} from "./ui.ts";

const clipperStyles = readFileSync(join(import.meta.dir, "../public/clipper.css"), "utf8");
const cockpitStyles = readFileSync(join(import.meta.dir, "../../cockpit/src/index.css"), "utf8");

test("clipper uses the Cockpit light and dark color tokens", () => {
  for (const declaration of [
    "--background: #ffffff",
    "--foreground: #020817",
    "--primary: #0f172a",
    "--accent: #2563eb",
    "--border: #e2e8f0",
    "--ring: #2563eb",
    "--background: #020817",
    "--foreground: #f8fafc",
    "--primary: #f8fafc",
    "--accent: #60a5fa",
    "--border: #334155",
    "--ring: #60a5fa",
  ]) {
    expect(clipperStyles).toContain(declaration);
    expect(cockpitStyles).toContain(declaration);
  }
  expect(clipperStyles).toContain("input:focus-visible");
  expect(clipperStyles).toContain("prefers-color-scheme: dark");
});

test("review prompt names the selected category without internal identifiers", () => {
  expect(intakeReviewPrompt(copy.de, "Recherche")).toBe(
    "Schau meine neuen Recherche-Einträge durch. Welche davon helfen uns? Schlage mit Quellenbezug vor, was wir als Wissen übernehmen sollten.",
  );
  expect(intakeReviewPrompt(copy.en, "Ideas")).toBe(
    "Review my new Ideas entries. Which ones help us? Propose what we should retain as knowledge, with its sources.",
  );
});

test("single-item review prompt leaves the referenced title to the mention", () => {
  expect(intakeItemReviewPrompt(copy.de)).toBe(
    "Prüfe diesen gesammelten Eintrag. Bewerte seinen Nutzen und bereite einen Vorschlag mit Quelle und Wissensziel zur Bestätigung vor.",
  );
  expect(intakeItemReviewPrompt(copy.en)).toBe(
    "Review this collected item. Assess its usefulness and prepare a proposal with its source and knowledge target for confirmation.",
  );
  expect(intakeItemReviewParams(copy.de, "clip-id")).toEqual({
    intake_item_ids: "clip-id",
    references: "intake_item:clip-id",
    prompt: intakeItemReviewPrompt(copy.de),
  });
});

test("content details measure and preview Markdown without markup or link targets", () => {
  const value = "# Heading\n\nA [link](https://example.test/path) with **text**.";
  expect(contentSummary(value)).toEqual({ characters: value.length, words: 6 });
  expect(previewText(value)).toBe("Heading\n\nA link with text.");
});

test("content details retain readable list text", () => {
  expect(previewText("- First\n- Second")).toBe("• First\n• Second");
  expect(previewBlocks("# Heading\n\n- First\n- [Second](https://example.test)")).toEqual([
    { kind: "heading", text: "Heading" },
    { kind: "list", text: "First" },
    { kind: "list", text: "Second" },
  ]);
});

test("source refresh ignores extension and browser pages", () => {
  expect(isCapturablePageUrl("https://example.test/page")).toBe(true);
  expect(isCapturablePageUrl("http://localhost:3000/page")).toBe(true);
  expect(isCapturablePageUrl("chrome://extensions")).toBe(false);
  expect(isCapturablePageUrl("chrome-extension://extension/popup.html")).toBe(false);
});

test("source refresh remains in the source window", () => {
  expect(isSourceWindow(3, 3)).toBe(true);
  expect(isSourceWindow(3, 4)).toBe(false);
  expect(isSourceWindow(undefined, 4)).toBe(true);
});

test("restored edited video Markdown does not select generated sections", () => {
  const sections = { description: "A description", transcript: "A transcript" };
  expect(
    generatedSectionSelection(
      "## Description\n\nA description\n\n## Transcript\n\nA transcript",
      sections,
    ),
  ).toEqual({ description: true, transcript: true });
  expect(
    generatedSectionSelection("## Description\n\nA description\n\nMy note", sections),
  ).toBeUndefined();
});
