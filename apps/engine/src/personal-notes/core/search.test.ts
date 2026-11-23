import { describe, expect, test } from "bun:test";
import { rankNotes, type SearchableNote, scoreNote, searchTokens } from "./search.ts";

function note(id: string, text: string, extra: Partial<SearchableNote> = {}): SearchableNote {
  return {
    id,
    text,
    abstract: null,
    confirmed: false,
    updated_at: new Date("2026-11-01T00:00:00Z"),
    ...extra,
  };
}

describe("searchTokens", () => {
  test("folds case, accents and punctuation and drops short words", () => {
    expect(searchTokens("Ich mag CAFÉ au lait, café!")).toEqual(["ich", "mag", "cafe", "lait"]);
  });

  test("an empty text has no tokens", () => {
    expect(searchTokens("  ")).toEqual([]);
  });
});

describe("scoreNote", () => {
  test("no query tokens and no overlap both score zero", () => {
    expect(scoreNote([], note("a", "invoices go out on Friday"))).toBe(0);
    expect(scoreNote(["holiday"], note("a", "invoices go out on Friday"))).toBe(0);
  });

  test("the share of matched query tokens is the score", () => {
    expect(scoreNote(["invoices", "friday"], note("a", "invoices go out on Friday"))).toBe(1);
    expect(scoreNote(["invoices", "monday"], note("a", "invoices go out on Friday"))).toBe(0.5);
  });

  test("a match in the abstract weighs more than one in the text alone", () => {
    const inText = scoreNote(["invoices"], note("a", "invoices go out on Friday"));
    const inAbstract = scoreNote(
      ["invoices"],
      note("a", "they go out on Friday", { abstract: "When invoices go out" }),
    );
    expect(inAbstract).toBeGreaterThan(inText);
  });
});

describe("rankNotes", () => {
  const notes = [
    note("a", "Invoices go out on Friday"),
    note("b", "Prefers short answers in German"),
    note("c", "Invoices are sent as PDF", { confirmed: true }),
  ];

  test("returns only notes that share a word with the query, best first", () => {
    const hits = rankNotes(notes, "when do invoices go out", 5);
    expect(hits.map((hit) => hit.note.id)).toEqual(["a", "c"]);
  });

  test("ties go to the confirmed note, then the newer one, then the id", () => {
    const tied = [
      note("b", "invoices weekly"),
      note("a", "invoices weekly"),
      note("d", "invoices weekly", { updated_at: new Date("2026-11-02T00:00:00Z") }),
      note("c", "invoices weekly", { confirmed: true }),
    ];
    expect(rankNotes(tied, "invoices", 10).map((hit) => hit.note.id)).toEqual(["c", "d", "a", "b"]);
  });

  test("the limit cuts the list and a negative limit returns nothing", () => {
    expect(rankNotes(notes, "invoices", 1)).toHaveLength(1);
    expect(rankNotes(notes, "invoices", -1)).toEqual([]);
  });

  test("a query without usable words finds nothing", () => {
    expect(rankNotes(notes, "an of", 5)).toEqual([]);
  });
});
