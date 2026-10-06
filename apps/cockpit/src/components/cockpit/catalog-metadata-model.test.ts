import { describe, expect, test } from "bun:test";
import {
  categoryChoices,
  metadataEndpoint,
  metadataPatch,
  normalizeCategoryInput,
  writtenByAssistant,
} from "./catalog-metadata-model";

describe("metadataEndpoint", () => {
  test("each kind saves through its own resource", () => {
    expect(metadataEndpoint("workflow", "w 1")).toBe("/v1/workflows/w%201/metadata");
    expect(metadataEndpoint("connector", "c")).toBe("/v1/connectors/c");
    expect(metadataEndpoint("knowledge_source", "k")).toBe("/v1/knowledge-sources/k");
    expect(metadataEndpoint("skill", "s")).toBe("/v1/skills/s");
    expect(metadataEndpoint("file", "fid_x")).toBe("/v1/files/fid_x");
  });
});

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
      description: "",
      category: "",
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
