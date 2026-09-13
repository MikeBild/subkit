import { describe, expect, test } from "bun:test";

import { parseOffer } from "./suggest-next-offer-parse.ts";

describe("parseOffer — English offer patterns", () => {
  test("captures 'Want me to X?'", () => {
    const result = parseOffer({
      assistant_text: "All set. Want me to commit and push it?",
    });
    expect(result).toEqual({
      suggestion: "commit and push it",
      kind: "text",
      offered_action: "commit and push it",
      reason: "offer-detected",
    });
  });

  test("captures 'Should I X?'", () => {
    const result = parseOffer({
      assistant_text: "Should I run the tests?",
    });
    expect(result?.suggestion).toBe("run the tests");
  });

  test("captures 'Shall I X?'", () => {
    const result = parseOffer({
      assistant_text: "Shall I deploy this to staging?",
    });
    expect(result?.suggestion).toBe("deploy this to staging");
  });

  test("captures 'Do you want me to X?'", () => {
    const result = parseOffer({
      assistant_text: "Do you want me to update the README?",
    });
    expect(result?.suggestion).toBe("update the README");
  });

  test("captures 'Would you like me to X?'", () => {
    const result = parseOffer({
      assistant_text: "Would you like me to open a PR?",
    });
    expect(result?.suggestion).toBe("open a PR");
  });

  test("returns null when the assistant did not offer anything", () => {
    expect(parseOffer({ assistant_text: "Done." })).toBeNull();
    expect(parseOffer({ assistant_text: "" })).toBeNull();
  });

  test("ignores offers that appear inside fenced code blocks", () => {
    const result = parseOffer({
      assistant_text: ["Here's the diff:", "```", "// Should I rebase?", "```", "Looks good."].join(
        "\n",
      ),
    });
    expect(result).toBeNull();
  });

  test("picks the LAST offer when multiple are present", () => {
    const result = parseOffer({
      assistant_text:
        "I could rebase. Should I rebase first? Or, alternatively — want me to commit and push it?",
    });
    expect(result?.suggestion).toBe("commit and push it");
  });

  test("strips trailing punctuation before the question mark", () => {
    const result = parseOffer({
      assistant_text: "Want me to commit it,?",
    });
    expect(result?.suggestion).toBe("commit it");
  });

  test("collapses internal whitespace", () => {
    const result = parseOffer({
      assistant_text: "Want me to   commit  the   change?",
    });
    expect(result?.suggestion).toBe("commit the change");
  });
});

describe("parseOffer — skill-aware resolution", () => {
  const loadedSkills = [
    { slug: "release-notes", verbs: ["draft", "generate"] as const },
    { slug: "deploy", verbs: ["deploy", "rollback"] as const },
  ];

  test("returns a slash invocation when the first verb matches a loaded skill", () => {
    const result = parseOffer({
      assistant_text: "Want me to draft the release notes?",
      loaded_skills: loadedSkills,
    });
    expect(result).toEqual({
      suggestion: "/skill release-notes draft",
      kind: "slash",
      offered_action: "draft the release notes",
      reason: "offer-skill",
    });
  });

  test("falls back to text when no skill verb matches", () => {
    const result = parseOffer({
      assistant_text: "Want me to commit and push it?",
      loaded_skills: loadedSkills,
    });
    expect(result?.kind).toBe("text");
    expect(result?.suggestion).toBe("commit and push it");
    expect(result?.reason).toBe("offer-detected");
  });

  test("matches verb case-insensitively", () => {
    const result = parseOffer({
      assistant_text: "Want me to Draft the changelog?",
      loaded_skills: loadedSkills,
    });
    expect(result?.kind).toBe("slash");
    expect(result?.suggestion).toBe("/skill release-notes draft");
  });

  test("only the FIRST word of the action is matched as the verb", () => {
    // 'commit and deploy' would NOT trigger the deploy skill because
    // the first word is 'commit', not 'deploy'.
    const result = parseOffer({
      assistant_text: "Want me to commit and deploy?",
      loaded_skills: loadedSkills,
    });
    expect(result?.kind).toBe("text");
  });
});
