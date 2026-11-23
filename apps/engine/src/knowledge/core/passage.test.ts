import { describe, expect, test } from "bun:test";
import { bestPassage, queryTerms } from "./passage.ts";

const filler = (n: number) => Array.from({ length: n }, (_, i) => `filler${i}`).join(" ");

describe("queryTerms", () => {
  test("lowercases, drops short words and repeats", () => {
    expect(queryTerms("How do I refund a Refund?")).toEqual(["how", "refund"]);
  });
});

describe("bestPassage", () => {
  test("short content is returned whole with whitespace collapsed", () => {
    expect(bestPassage("  one\n\n two  ", "anything")).toBe("one two");
  });

  test("the passage is centred on the query words, not on the start of the chunk", () => {
    const content = `${filler(200)} refunds are sent back within five days ${filler(200)}`;
    const passage = bestPassage(content, "when are refunds sent");
    expect(passage.length).toBeLessThanOrEqual(300);
    expect(passage).toContain("refunds are sent back within five days");
  });

  test("the window covering the most distinct query words wins", () => {
    const content = `invoice ${filler(120)} the invoice reminder goes out on monday ${filler(120)}`;
    const passage = bestPassage(content, "invoice reminder monday");
    expect(passage).toContain("invoice reminder goes out on monday");
  });

  test("without any match the passage is the head of the content", () => {
    const content = filler(200);
    const passage = bestPassage(content, "zebra");
    expect(passage.startsWith("filler0 ")).toBe(true);
    expect(passage.length).toBeLessThanOrEqual(300);
  });

  test("the passage starts and ends on word boundaries", () => {
    const content = `${filler(100)} needle ${filler(100)}`;
    const passage = bestPassage(content, "needle", 120);
    expect(passage.length).toBeLessThanOrEqual(120);
    for (const word of passage.split(" ")) expect(word).toMatch(/^(filler\d+|needle)$/);
  });

  test("a match at the very end still yields a full window", () => {
    const content = `${filler(100)} needle`;
    const passage = bestPassage(content, "needle", 100);
    expect(passage.endsWith("needle")).toBe(true);
    expect(passage.length).toBeGreaterThan(50);
  });

  test("a non-positive maximum yields nothing", () => {
    expect(bestPassage("some content", "content", 0)).toBe("");
  });
});
