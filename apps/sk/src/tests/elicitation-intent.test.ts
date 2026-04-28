// Property-style coverage of the free-text → elicitation intent
// classifier. The bug this prevents: the previous CLI used a literal
// allow-list of eight magic words ("yes", "y", "approve", "ok", "okay",
// "confirm", "go", "do it"). Anything else fell through and got sent as
// a brand-new prompt while the engine was still in `awaiting_input`,
// producing the "save it" / "yes for option 2" / "please save" silent
// drops in session bc745e38.
//
// The invariants here:
//   - common compound affirmatives map to `confirm`
//   - common compound rejections map to `reject`
//   - "option N" / "yes for option N" / "N" map to `pick(N)`
//   - genuinely ambiguous text returns `ambiguous` (so the caller can
//     show a hint instead of forwarding the text as a new prompt)

import { describe, expect, test } from "bun:test";
import { classifyElicitationIntent } from "../elicitation-intent.ts";

describe("classifyElicitationIntent — confirm shapes", () => {
  const confirms = [
    "yes",
    "Yes",
    "YES",
    "y",
    "Y",
    "yep",
    "yeah",
    "yup",
    "sure",
    "of course",
    "absolutely",
    "ok",
    "okay",
    "OK",
    "fine",
    "approve",
    "approved",
    "confirm",
    "confirmed",
    "go",
    "go ahead",
    "go ahead and save it",
    "go ahead and do it",
    "do it",
    "save",
    "save it",
    "please",
    "please save",
    "commit",
    "commit it",
    "ship it",
    "looks good",
    "lgtm",
    "sounds good",
    "sounds great",
    // trailing punctuation tolerated
    "yes.",
    "save it!",
    "okay?",
  ];

  for (const t of confirms) {
    test(`"${t}" → confirm`, () => {
      expect(classifyElicitationIntent(t).kind).toBe("confirm");
    });
  }
});

describe("classifyElicitationIntent — reject shapes", () => {
  const rejects = [
    "no",
    "No",
    "n",
    "nope",
    "nah",
    "no thanks",
    "no thank",
    "cancel",
    "abort",
    "reject",
    "rejected",
    "stop",
    "don't",
    "dont",
    "never mind",
    "nevermind",
    "hold on",
    "wait",
    "no.",
    "stop!",
  ];

  for (const t of rejects) {
    test(`"${t}" → reject`, () => {
      expect(classifyElicitationIntent(t).kind).toBe("reject");
    });
  }
});

describe("classifyElicitationIntent — pick shapes", () => {
  const picks: Array<[string, number]> = [
    ["1", 1],
    ["2", 2],
    ["42", 42],
    ["option 1", 1],
    ["option 2", 2],
    ["Option  3", 3],
    ["yes for option 2", 2],
    ["pick 3", 3],
    ["choose 4", 4],
    ["select option 5", 5],
  ];

  for (const [t, idx] of picks) {
    test(`"${t}" → pick(${idx})`, () => {
      const r = classifyElicitationIntent(t);
      expect(r.kind).toBe("pick");
      if (r.kind === "pick") expect(r.optionIndex).toBe(idx);
    });
  }
});

describe("classifyElicitationIntent — ambiguous shapes (the negative-space invariant)", () => {
  // Anything in here MUST return `ambiguous` so the CLI shows a hint
  // instead of either resolving the elicitation with the wrong answer
  // OR silently forwarding the text as a phantom new prompt.
  const ambiguous = [
    "",
    "   ",
    "tell me more",
    "what about Foo?",
    "explain",
    "?",
    "huh",
    "I don't know",
    "show me the diff first",
    "save it for project Foo", // free-text that contains an affirmative is NOT a confirm
    "say yes to all",
    "yes please save the workflow named foo bar baz", // longer than the compound affirmative phrases
    "0", // zero / negative numbers aren't valid option picks
    "99999", // out-of-range option index
  ];

  for (const t of ambiguous) {
    test(`"${t}" → ambiguous`, () => {
      expect(classifyElicitationIntent(t).kind).toBe("ambiguous");
    });
  }
});

describe("classifyElicitationIntent — invariant: never throws", () => {
  // The classifier is on the hot path of every keystroke during a
  // pending elicitation. A throw would crash the REPL turn handler.
  test("garbage / unicode / very long inputs do not throw", () => {
    const inputs = [
      "🚀🔥",
      "a".repeat(10_000),
      "\n\n\n\t\t",
      "${item.id}",
      "DROP TABLE users;",
      "<script>alert(1)</script>",
    ];
    for (const t of inputs) {
      expect(() => classifyElicitationIntent(t)).not.toThrow();
    }
  });
});
