import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  contentSummary,
  copy,
  generatedSectionSelection,
  helpUrl,
  intakeItemReviewParams,
  intakeItemReviewPrompt,
  intakeReviewPrompt,
  isCapturablePageUrl,
  isSourceWindow,
  offersHelp,
  previewBlocks,
  previewText,
  showHelpLink,
  workerCopy,
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
    "Schau meine neuen Recherche-Einträge durch. Welche davon helfen uns? Schlage mit Quellenbezug vor, was wir übernehmen sollten, als Wissen oder als Skill.",
  );
  expect(intakeReviewPrompt(copy.en, "Ideas")).toBe(
    "Review my new Ideas entries. Which ones help us? Propose what we should retain, as knowledge or as a skill, with its sources.",
  );
});

test("single-item review prompt leaves the referenced title to the mention", () => {
  expect(intakeItemReviewPrompt(copy.de)).toBe(
    "Prüfe diesen gesammelten Eintrag. Bewerte seinen Nutzen und bereite einen Vorschlag mit Quelle und Ziel zur Bestätigung vor, als Wissen oder als Skill.",
  );
  expect(intakeItemReviewPrompt(copy.en)).toBe(
    "Review this collected item. Assess its usefulness and prepare a proposal with its source and destination, as knowledge or as a skill, for confirmation.",
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

test("help opens the Web Clipper chapter on the configured engine", () => {
  expect(helpUrl("https://engine.example")).toBe("https://engine.example/cockpit/docs/web-clipper");
  expect(helpUrl("https://engine.example/base")).toBe(
    "https://engine.example/base/cockpit/docs/web-clipper",
  );
  expect(helpUrl(undefined)).toBeUndefined();
  expect(helpUrl("")).toBeUndefined();
});

test("troubleshooting messages offer help and ordinary hints do not", () => {
  for (const text of [copy.de, copy.en]) {
    expect(offersHelp(text, text.invalidApiKey)).toBe(true);
    expect(offersHelp(text, text.missingIntakeReadPermission)).toBe(true);
    expect(offersHelp(text, text.connectionFailed)).toBe(true);
    expect(offersHelp(text, `${text.apiResponseFailed} (HTTP 500)`)).toBe(true);
    expect(offersHelp(text, text.contentChanged)).toBe(false);
    expect(offersHelp(text, text.emptyPreview)).toBe(false);
  }
});

test("every clipper text exists in German and English", () => {
  for (const values of [copy, workerCopy]) {
    expect(Object.keys(values.de).sort()).toEqual(Object.keys(values.en).sort());
    for (const language of ["de", "en"] as const) {
      for (const value of Object.values(values[language])) expect(value.trim()).not.toBe("");
    }
  }
});

test("German clipper text addresses the reader informally", () => {
  const formal = /\b(Sie|Ihr|Ihre|Ihren|Ihrem|Ihrer|Ihnen)\b/;
  for (const value of [...Object.values(copy.de), ...Object.values(workerCopy.de)]) {
    expect(value).not.toMatch(formal);
  }
  for (const page of ["popup.html", "options.html"]) {
    expect(readFileSync(join(import.meta.dir, "../public", page), "utf8")).not.toMatch(formal);
  }
});

function cockpitLabels(key: string): { en: string; de: string } {
  const dir = join(import.meta.dir, "../../cockpit/src/lib/i18n");
  const source = readdirSync(dir)
    .sort()
    .map((file) => readFileSync(join(dir, file), "utf8"))
    .join("\n");
  const pattern = new RegExp(`"${key.replaceAll(".", "\\.")}":\\s*"([^"]+)"`, "g");
  const [en, de] = [...source.matchAll(pattern)].map((match) => match[1] ?? "");
  if (!en || !de) throw new Error(`Cockpit label ${key} is missing`);
  return { en, de };
}

test("missing intake write names the Cockpit key preset and page labels", () => {
  const preset = cockpitLabels("apiKeys.preset.clipper");
  const page = cockpitLabels("nav.apiAccess");
  for (const key of [
    "invalidApiKey",
    "missingIntakeReadPermission",
    "missingIntakeWritePermission",
  ] as const) {
    expect(copy.de[key]).toContain(`„${preset.de}“`);
    expect(copy.de[key]).toContain(`„${page.de}“`);
    expect(copy.en[key]).toContain(`“${preset.en}”`);
    expect(copy.en[key]).toContain(`“${page.en}”`);
  }
});

test("help link follows the configured engine address", () => {
  const link = { hidden: true, href: "about:blank" } as HTMLAnchorElement;
  showHelpLink(link, "https://engine.example");
  expect(link.hidden).toBe(false);
  expect(link.href).toBe("https://engine.example/cockpit/docs/web-clipper");
  showHelpLink(link, undefined);
  expect(link.hidden).toBe(true);
  expect(link.href).toBe("about:blank");
  showHelpLink(link, "");
  expect(link.hidden).toBe(true);
  expect(() => showHelpLink(null, "https://engine.example")).not.toThrow();
});

test("help links start hidden next to the gear and under the settings intro", () => {
  const popup = readFileSync(join(import.meta.dir, "../public/popup.html"), "utf8");
  const options = readFileSync(join(import.meta.dir, "../public/options.html"), "utf8");
  const masthead = popup.match(/<header class="masthead">([\s\S]*?)<\/header>/)?.[1] ?? "";
  expect(masthead).toMatch(/<a id="help"[^>]*\bhidden\b[^>]*>[^<]*<\/a>\s*<button id="setup"/);
  expect(options).toMatch(
    /<p class="intro" data-i18n="intro">[^<]*<\/p>\s*<a id="help"[^>]*\bhidden\b[^>]*>[^<]*<\/a>/,
  );
  for (const page of [popup, options]) {
    for (const link of page.match(/<a [^>]*data-i18n="help"[^>]*>/g) ?? []) {
      expect(link).toContain('target="_blank"');
      expect(link).toContain('rel="noreferrer"');
    }
  }
});

test("service worker messages come from the translated worker copy", () => {
  const worker = readFileSync(join(import.meta.dir, "service-worker.ts"), "utf8");
  expect(worker).not.toMatch(/new Error\(\s*["'`]/);
  expect(workerCopy.de.pageChanged).toContain("Erfasse");
  expect(workerCopy.en.pageChanged).toContain("Capture it again");
});
