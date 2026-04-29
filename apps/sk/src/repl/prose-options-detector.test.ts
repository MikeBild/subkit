// Bug II regression: the LLM emits a numbered options list with a
// trailing question ("1. … 2. … Which would you prefer?") despite
// the STRUCTURED USER INTERACTION skill rule. The CLI now
// translates that shape into a real ChoicePrompt. These tests pin
// the detector contract so it never silently widens (false positives
// on ordinary numbered prose) or narrows (regressions on the exact
// shape the LLM keeps emitting).

import { describe, expect, test } from "bun:test";
import { detectProseOptions } from "./prose-options-detector.ts";

describe("detectProseOptions · numbered prose → ChoicePrompt", () => {
  test("matches the canonical 'Which would you prefer?' fork", () => {
    const text = [
      "Here are two ways to proceed:",
      "",
      "1. Run the existing workflow as-is",
      "2. Show you the diff first, then run it",
      "",
      "Which would you prefer?",
    ].join("\n");
    const got = detectProseOptions(text);
    expect(got).not.toBeNull();
    expect(got?.options).toHaveLength(2);
    expect(got?.options[0]?.index).toBe(1);
    expect(got?.options[0]?.label).toBe("Run the existing workflow as-is");
    expect(got?.options[1]?.label).toBe("Show you the diff first, then run it");
    expect(got?.question).toBe("Which would you prefer?");
  });

  test("matches '1)' style as well as '1.' when question is a pick", () => {
    const text = [
      "1) Adjust the output format",
      "2) Skip the adjustment",
      "Which option would you prefer?",
    ].join("\n");
    const got = detectProseOptions(text);
    expect(got).not.toBeNull();
    expect(got?.options).toHaveLength(2);
    expect(got?.options[0]?.label).toBe("Adjust the output format");
  });

  test("strips a trailing 'or' from the last option label", () => {
    // The LLM frequently writes "1. Do A, 2. Do B, or" — we drop
    // the trailing 'or' so the rendered label reads cleanly.
    const text = ["1. Run the workflow", "2. Show the diff, or", "Which would you prefer?"].join(
      "\n",
    );
    const got = detectProseOptions(text);
    expect(got?.options[1]?.label).toBe("Show the diff");
  });

  test("returns null when only one numbered item is present", () => {
    const text = ["1. Just one option here", "What do you want to do?"].join("\n");
    expect(detectProseOptions(text)).toBeNull();
  });

  test("returns null when the trailing line does not end with '?'", () => {
    const text = ["1. Option A", "2. Option B", "Pick one and let me know."].join("\n");
    expect(detectProseOptions(text)).toBeNull();
  });

  // Bug II.b regression — session 16d6e46a — the LLM described a
  // workflow with 4 numbered bullets ("1. Fetches… 2. Loops…
  // 3. Fetches… 4. Returns a formatted list…") and asked "Would you
  // like me to run this workflow for you now?". The detector treated
  // the bullets as a fork; the user picked option 4 ("Returns a
  // formatted list…"); the engine treated that as a free-text
  // prompt; a duplicate `you` line landed in the transcript. Yes/no
  // questions are now an explicit exclusion.
  test("returns null when the trailing question is yes/no ('Would you…?')", () => {
    const text = [
      'The "DigitalOcean Projects and Resources" workflow:',
      "",
      "1. Fetches all your DigitalOcean projects",
      "2. Loops through each project",
      "3. Fetches resources for each project",
      "4. Returns a formatted list of projects with their resources",
      "",
      "Would you like me to run this workflow for you now?",
    ].join("\n");
    expect(detectProseOptions(text)).toBeNull();
  });

  test("returns null on other yes/no shapes ('Do you…?', 'Should I…?', 'Can I…?')", () => {
    for (const q of [
      "Do you want me to proceed?",
      "Should I run the workflow now?",
      "Shall I commit it?",
      "Can I save this for you?",
      "Could you confirm before I run it?",
    ]) {
      const text = ["1. First option", "2. Second option", q].join("\n");
      expect(detectProseOptions(text)).toBeNull();
    }
  });

  test("returns null when the trailing question has no pick marker (no 'which', 'prefer', 'pick', etc)", () => {
    const text = [
      "1. Authentication failed",
      "2. The token expired yesterday",
      "What does this mean for the deploy?",
    ].join("\n");
    // No pick marker → looks like prose Q&A about a list, not a
    // user-facing fork.
    expect(detectProseOptions(text)).toBeNull();
  });

  test("returns null when the numeric indices are not contiguous 1..N", () => {
    // Paragraph numbering ("In step 2 we will…") is not a fork —
    // requiring a contiguous 1..N sequence is what keeps the
    // detector narrow.
    const text = ["2. Apply the patch", "5. Roll back if it fails", "Which would you prefer?"].join(
      "\n",
    );
    expect(detectProseOptions(text)).toBeNull();
  });

  test("returns null on empty / whitespace-only input", () => {
    expect(detectProseOptions("")).toBeNull();
    expect(detectProseOptions("   \n\n\t\n")).toBeNull();
  });

  test("preserves the option label as the value (so the LLM recognises the reply)", () => {
    const text = [
      "1. Run the existing workflow",
      "2. Show me the diff",
      "Which would you prefer?",
    ].join("\n");
    const got = detectProseOptions(text);
    // The chosen value must be a sentence the LLM can interpret on
    // the next turn — not a bare digit ("1") that the engine would
    // then have to re-classify.
    expect(got?.options[0]?.value).toBe("Run the existing workflow");
    expect(got?.options[1]?.value).toBe("Show me the diff");
  });

  test("requires at least 2 contiguous numbered options before the question", () => {
    const text = [
      "Some preamble text.",
      "",
      "1. First",
      "Some interrupting sentence",
      "2. Second",
      "Which one?",
    ].join("\n");
    // Walk-back from the `?` line stops at the first non-numbered
    // line, so only "2. Second" is collected → < 2 → null.
    expect(detectProseOptions(text)).toBeNull();
  });

  test("handles three or more options in sequence", () => {
    const text = [
      "1. Adjust the format",
      "2. Run as-is",
      "3. Cancel and revise",
      "Which would you prefer?",
    ].join("\n");
    const got = detectProseOptions(text);
    expect(got?.options).toHaveLength(3);
    expect(got?.options[2]?.label).toBe("Cancel and revise");
  });

  test("matches the actual session 86de186b prose ('would you prefer to adjust …?')", () => {
    // Lifted from the user-reported transcript so the detector
    // proves it covers the exact wording the LLM keeps emitting.
    const text = [
      "I see two ways forward.",
      "",
      "1. Run the workflow without project names",
      "2. Adjust the output format to include project names (which would require me to explain the fix for you to review first)",
      "",
      "Which would you prefer?",
    ].join("\n");
    const got = detectProseOptions(text);
    expect(got).not.toBeNull();
    expect(got?.options).toHaveLength(2);
    expect(got?.options[1]?.label).toContain("Adjust the output format");
  });
});
