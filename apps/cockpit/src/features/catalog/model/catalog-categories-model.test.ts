import { describe, expect, test } from "bun:test";
import {
  type CategoryUsage,
  categoryAliases,
  categoryEditPayload,
  categoryMatches,
} from "./catalog-categories-model";

const source: CategoryUsage = {
  category: "finance-team",
  purpose: "Rechnungen prüfen",
  purpose_source: "llm",
  aliases: ["Buchhaltung"],
  revision: 4,
  total: 1,
  counts: { workflow: 1, connector: 0, knowledge_source: 0, skill: 0, file: 0, task: 0 },
};

describe("shared category editing", () => {
  test("finds a category by canonical name, readable words, purpose or alternate words", () => {
    for (const query of ["finance-team", "finance team", "RECHNUNGEN", "Buchhaltung prüfen", ""])
      expect(categoryMatches(source, query)).toBe(true);
    expect(categoryMatches(source, "Kalender")).toBe(false);
  });

  test("adopts a displayed AI purpose through a same-name save with both source revisions", () => {
    expect(
      categoryEditPayload(source, undefined, source.category, source.purpose ?? "", "Buchhaltung"),
    ).toEqual({
      to: source.category,
      purpose: source.purpose ?? null,
      aliases: ["Buchhaltung"],
      expected_source_revision: 4,
      expected_target_revision: 4,
    });
  });

  test("a merge carries the displayed target revision and the submitted source facts", () => {
    const target = { ...source, category: "accounts", revision: 8, purpose: "Zielzweck" };
    expect(categoryEditPayload(source, target, "accounts", "Mein Zweck", "Belege")).toEqual({
      to: "accounts",
      purpose: "Mein Zweck",
      aliases: ["Belege"],
      expected_source_revision: 4,
      expected_target_revision: 8,
    });
    expect(target.purpose).toBe("Zielzweck");
  });

  test("blank purpose requests generation without inventing text and absent metadata stays explicit", () => {
    expect(
      categoryEditPayload({ ...source, revision: null }, undefined, "new-name", "  ", ""),
    ).toEqual({
      to: "new-name",
      purpose: null,
      aliases: [],
      expected_source_revision: null,
      expected_target_revision: null,
    });
  });

  test("alternate words preserve natural language while deduplicating normalized spelling", () => {
    expect(
      categoryAliases("  Jahres Abschluss, jahres abschluss, Ｒｅｐｏｒｔ, Report,, "),
    ).toEqual(["Jahres Abschluss", "Report"]);
  });
});
