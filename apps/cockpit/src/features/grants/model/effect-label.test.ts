import { expect, test } from "bun:test";
import { effectLabel, humanize } from "@/features/grants/model/effect-label";
import { type Locale, type TranslationKey, translate } from "@/lib/i18n";

const t = (locale: Locale) => (key: TranslationKey) => translate(locale, key);

test("known subjects read as words in either language", () => {
  expect(effectLabel(t("de"), "comments", "post_comment")).toBe("Kommentare");
  expect(effectLabel(t("en"), "comments", "post_comment")).toBe("Comments");
  expect(effectLabel(t("de"), "Issues", "list")).toBe("Issues");
  expect(effectLabel(t("en"), "pulls", "list")).toBe("Pull requests");
});

test("unknown subjects are humanized, then the step id", () => {
  expect(effectLabel(t("en"), "project_items", "x")).toBe("Project items");
  expect(effectLabel(t("en"), null, "fetchOpenIssues")).toBe("Fetch open issues");
  expect(effectLabel(t("de"), "", "load-main-ref")).toBe("Load main ref");
});

test("humanize decodes and splits separators and camel case", () => {
  expect(humanize("release%20notes")).toBe("Release notes");
  expect(humanize("__a.b__")).toBe("A b");
});
