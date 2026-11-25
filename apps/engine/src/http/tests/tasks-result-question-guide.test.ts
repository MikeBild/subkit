import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { asksForTheTaskRunResult } from "../../conversations/core/task-run-result.ts";

const repoRoot = join(import.meta.dir, "../../../../..");
const readRepoFile = (relativePath: string) => readFileSync(join(repoRoot, relativePath), "utf8");

const tasksCatalog = readRepoFile("apps/cockpit/src/lib/i18n/tasks.ts");
const catalogLabels = (key: string) =>
  [...tasksCatalog.matchAll(new RegExp(`"${key.replaceAll(".", "\\.")}": "([^"]+)"`, "g"))].map(
    (match) => match[1] ?? "",
  );
const [englishAccept = "", germanAccept = ""] = catalogLabels("tasks.review.accept");
const [englishReview = "", germanReview = ""] = catalogLabels("tasks.action.review");

const englishGuide = readRepoFile("apps/engine/src/http/reference/tasks.en.md");
const germanGuide = readRepoFile("apps/engine/src/http/reference/tasks.de.md");

const resultReadyParagraph = (text: string, acceptLabel: string, reviewLabel: string) =>
  text
    .split("\n\n")
    .find(
      (paragraph) =>
        paragraph.includes(`**${acceptLabel}** `) &&
        paragraph.endsWith(".") &&
        paragraph.includes(`**${reviewLabel}**`) &&
        !paragraph.startsWith("1."),
    ) ?? "";

const sentenceCount = (paragraph: string) => paragraph.split(/(?<=[.!?])\s+/u).length;

const goal = "Is the final synthetic inventory result correct";

describe("task guide on result questions of a run", () => {
  test("the engine holds back result-step bindings and normalized goal or confirmation questions", () => {
    const reserved = { goal, result_question: "Does this result meet your expectations?" };
    expect(
      asksForTheTaskRunResult(
        { playbook_step_id: "confirm-result", question: "Which inventory?" },
        reserved,
      ),
    ).toBe(true);
    expect(
      asksForTheTaskRunResult(
        { question: "  DOES this result meet your expectations?! " },
        reserved,
      ),
    ).toBe(true);
    expect(
      asksForTheTaskRunResult(
        { question: "  is the FINAL synthetic inventory result correct?! " },
        reserved,
      ),
    ).toBe(true);
    expect(
      asksForTheTaskRunResult(
        { question: "Is the final synthetic inventory result correct and ready to approve?" },
        reserved,
      ),
    ).toBe(false);
  });

  test("the English guide no longer promises that the run never asks about its result", () => {
    expect(englishGuide).not.toContain(
      "The run does not ask you itself whether the result is right",
    );
  });

  test("the English guide states all suppression rules and that paraphrases can get through", () => {
    const paragraph = resultReadyParagraph(englishGuide, englishAccept, englishReview);
    expect(paragraph).toContain("bound to the reserved `confirm-result` step");
    expect(paragraph).toContain("matches that step’s confirmation question");
    expect(paragraph).toContain("repeats the goal of the task word for word");
    expect(paragraph).toContain("A question that asks the same in other words can still reach you");
    expect(paragraph).toContain(`only **${englishAccept}** under **${englishReview}** does`);
  });

  test("both guides name the opt-in result question check and its failure behaviour", () => {
    const englishParagraph = resultReadyParagraph(englishGuide, englishAccept, englishReview);
    const germanParagraph = resultReadyParagraph(germanGuide, germanAccept, germanReview);
    expect(englishParagraph).toContain(
      "unless you switch on the setting `llm.result_question_check`",
    );
    expect(englishParagraph).toContain("a question still gets through when that call fails");
    expect(germanParagraph).toContain("`llm.result_question_check`");
  });

  test("the German twin carries the same paragraph with the cockpit labels", () => {
    expect(germanAccept.length).toBeGreaterThan(0);
    expect(germanReview.length).toBeGreaterThan(0);
    const englishParagraph = resultReadyParagraph(englishGuide, englishAccept, englishReview);
    const germanParagraph = resultReadyParagraph(germanGuide, germanAccept, germanReview);
    expect(germanParagraph).toContain("`confirm-result`");
    expect(germanParagraph).toContain("Best\u00e4tigungsfrage");
    expect(sentenceCount(germanParagraph)).toBe(sentenceCount(englishParagraph));
  });
});
