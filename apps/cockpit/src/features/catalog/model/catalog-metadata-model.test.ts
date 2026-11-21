import { describe, expect, test } from "bun:test";
import {
  categoryChoices,
  metadataPatch,
  normalizeCategoryInput,
  writtenByAssistant,
} from "./catalog-metadata-model";

describe("metadataPatch", () => {
  const record = { description: "Sends the report.", category: "reports" };

  test("sends nothing when nothing changed", () => {
    expect(
      metadataPatch(record, { description: " Sends the report. ", category: "reports" }),
    ).toBeNull();
  });

  test("sends only the changed field", () => {
    expect(
      metadataPatch(record, { description: "Sends the report.", category: "billing" }),
    ).toEqual({
      category: "billing",
    });
  });

  test("an emptied description or the catch-all hands the field back to automation", () => {
    expect(metadataPatch(record, { description: "", category: "other" })).toEqual({
      description: null,
      category: null,
    });
  });

  test("an empty category draft clears the category like the catch-all", () => {
    expect(metadataPatch(record, { description: "Sends the report.", category: "" })).toEqual({
      category: null,
    });
  });
});

describe("normalizeCategoryInput", () => {
  test("turns typed words into the shared category shape", () => {
    expect(normalizeCategoryInput("Sales Reports")).toBe("sales-reports");
    expect(normalizeCategoryInput("Übersicht")).toBe("ubersicht");
    expect(normalizeCategoryInput("!!")).toBeNull();
  });
});

describe("categoryChoices", () => {
  test("lists the vocabulary once, keeps the current one, and the catch-all last", () => {
    expect(categoryChoices(["reports", "billing", "other", "platform"], "legacy")).toEqual([
      "billing",
      "legacy",
      "reports",
      "other",
    ]);
  });
});

describe("writtenByAssistant", () => {
  test("only a non-empty text the assistant wrote is marked", () => {
    expect(writtenByAssistant({ description: "x", description_source: "llm" })).toBe(true);
    expect(writtenByAssistant({ description: "x", description_source: "human" })).toBe(false);
    expect(writtenByAssistant({ description: null, description_source: "llm" })).toBe(false);
  });
});
