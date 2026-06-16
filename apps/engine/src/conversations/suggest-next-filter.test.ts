import { describe, expect, test } from "bun:test";
import { filterSuggestion } from "./suggest-next-filter.ts";

describe("filterSuggestion", () => {
  test("passes a typical action suggestion", () => {
    expect(filterSuggestion("commit and push it")).toBeNull();
    expect(filterSuggestion("run the tests")).toBeNull();
  });

  test("passes a slash command of any length", () => {
    expect(filterSuggestion("/skill release-notes draft")).toBeNull();
    expect(filterSuggestion("/save")).toBeNull();
  });

  test("passes whitelisted single words", () => {
    for (const w of ["yes", "no", "commit", "push", "ok"]) {
      expect(filterSuggestion(w)).toBeNull();
    }
  });

  test("rejects empty / whitespace-only input", () => {
    expect(filterSuggestion("")).toBe("empty");
    expect(filterSuggestion("   ")).toBe("empty");
    expect(filterSuggestion(null)).toBe("empty");
    expect(filterSuggestion(undefined)).toBe("empty");
  });

  test("rejects literal 'done'", () => {
    expect(filterSuggestion("done")).toBe("done");
    expect(filterSuggestion("Done")).toBe("done");
  });

  test("rejects meta-text", () => {
    expect(filterSuggestion("Nothing found.")).toBe("meta_text");
    expect(filterSuggestion("no suggestion")).toBe("meta_text");
    expect(filterSuggestion("nothing to suggest right now")).toBe("meta_text");
    expect(filterSuggestion("silence")).toBe("meta_text");
    expect(filterSuggestion("staying silent")).toBe("meta_text");
  });

  test("rejects wrapped meta-reasoning", () => {
    expect(filterSuggestion("(silence — nothing obvious)")).toBe("meta_wrapped");
    expect(filterSuggestion("[no suggestion]")).toBe("meta_wrapped");
  });

  test("rejects provider error strings", () => {
    expect(filterSuggestion("API error: rate limit")).toBe("error_message");
    expect(filterSuggestion("Prompt is too long")).toBe("error_message");
  });

  test("rejects labelled output", () => {
    expect(filterSuggestion("Suggestion: run the tests")).toBe("prefixed_label");
    expect(filterSuggestion("Action: deploy")).toBe("prefixed_label");
  });

  test("rejects too-few non-whitelisted single words", () => {
    expect(filterSuggestion("foo")).toBe("too_few_words");
    expect(filterSuggestion("hmm")).toBe("too_few_words");
  });

  test("rejects too-many words", () => {
    expect(
      filterSuggestion("one two three four five six seven eight nine ten eleven twelve thirteen"),
    ).toBe("too_many_words");
  });

  test("rejects suggestions ≥100 chars (multi-word, under 12)", () => {
    // 5 words, 104 chars — slips past too_few_words and too_many_words.
    const s =
      "twentycharsofletters twentycharsofletters twentycharsofletters twentycharsofletters twentycharsofletters";
    expect(s.length).toBeGreaterThanOrEqual(100);
    expect(filterSuggestion(s)).toBe("too_long");
  });

  test("rejects multiple sentences", () => {
    expect(filterSuggestion("Run the tests. Then push.")).toBe("multiple_sentences");
  });

  test("rejects formatted output", () => {
    expect(filterSuggestion("run **the** tests")).toBe("has_formatting");
    expect(filterSuggestion("line one\nline two")).toBe("has_formatting");
    expect(filterSuggestion("* bullet")).toBe("has_formatting");
  });

  test("rejects evaluative phrasing (rule fires after too_few_words)", () => {
    // Multi-word phrases — single-word "thanks!" / "great" hit too_few_words first.
    expect(filterSuggestion("looks good")).toBe("evaluative");
    expect(filterSuggestion("thanks for that")).toBe("evaluative");
    expect(filterSuggestion("that works for me")).toBe("evaluative");
  });

  test("rejects claude-voice openers", () => {
    expect(filterSuggestion("Let me commit it")).toBe("claude_voice");
    expect(filterSuggestion("I'll push it")).toBe("claude_voice");
    expect(filterSuggestion("Here's what I think")).toBe("claude_voice");
    expect(filterSuggestion("You should commit")).toBe("claude_voice");
  });

  test("rejects enumerate-a-resource suggestions for non-existent catalogs", () => {
    // The reported bug: after "list my workflows / skills / …" the model
    // extrapolates a plausible but non-existent next catalog.
    expect(filterSuggestion("list my agents")).toBe("unknown_catalog");
    expect(filterSuggestion("show my pipelines")).toBe("unknown_catalog");
    expect(filterSuggestion("list all bots")).toBe("unknown_catalog");
  });

  test("passes enumerate-a-resource suggestions for real catalogs", () => {
    expect(filterSuggestion("list my workflows")).toBeNull();
    expect(filterSuggestion("show my connectors")).toBeNull();
    expect(filterSuggestion("list my knowledge sources")).toBeNull();
    expect(filterSuggestion("show all skills")).toBeNull();
    expect(filterSuggestion("list the recent executions")).toBeNull();
  });

  test("does not over-filter free-form suggestions that start with a list verb", () => {
    // No "my/all/the/our" possessive → not the enumerate-a-resource shape.
    expect(filterSuggestion("show me the diff")).toBeNull();
    expect(filterSuggestion("list of changes")).toBeNull();
  });
});
