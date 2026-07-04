// "Did you mean" suggestion logic for the top-level dispatcher.

import { describe, expect, test } from "bun:test";
import { levenshtein, suggestCommand } from "../lib/suggest.ts";

const COMMANDS = [
  "login",
  "logout",
  "status",
  "tenants",
  "doctor",
  "health",
  "logs",
  "sessions",
  "connectors",
  "connector-templates",
  "workflows",
  "executions",
  "schedules",
  "skills",
  "knowledge-sources",
];

describe("levenshtein", () => {
  test("identical strings have distance 0", () => {
    expect(levenshtein("doctor", "doctor")).toBe(0);
  });
  test("single dropped char has distance 1", () => {
    expect(levenshtein("conectors", "connectors")).toBe(1);
  });
  test("empty vs word is the word length", () => {
    expect(levenshtein("", "abc")).toBe(3);
  });
});

describe("suggestCommand", () => {
  test("one-char typo suggests the command", () => {
    expect(suggestCommand("conectors", COMMANDS)).toBe("connectors");
  });
  test("transposition-style typo within distance 2 suggests", () => {
    expect(suggestCommand("wrokflows", COMMANDS)).toBe("workflows");
  });
  test("case-insensitive match", () => {
    expect(suggestCommand("Doctor", COMMANDS)).toBe("doctor");
  });
  test("an exact command name returns null (the dispatcher already handled it)", () => {
    expect(suggestCommand("doctor", COMMANDS)).toBeNull();
  });
  test("a plausible natural-language word stays a prompt (no suggestion)", () => {
    expect(suggestCommand("hello", COMMANDS)).toBeNull();
    expect(suggestCommand("summarize", COMMANDS)).toBeNull();
  });
});
