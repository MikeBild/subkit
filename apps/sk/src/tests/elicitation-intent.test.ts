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
    "save it for project Foo",
    "say yes to all",
    "yes please save the workflow named foo bar baz",
    "0",
    "99999",
  ];

  for (const t of ambiguous) {
    test(`"${t}" → ambiguous`, () => {
      expect(classifyElicitationIntent(t).kind).toBe("ambiguous");
    });
  }
});

describe("classifyElicitationIntent — invariant: never throws", () => {
  test("garbage / unicode / very long inputs do not throw", () => {
    const inputs = [
      "🚀🔥",
      "a".repeat(10_000),
      "\n\n\n\t\t",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder token under test
      "${item.id}",
      "DROP TABLE users;",
      "<script>alert(1)</script>",
    ];
    for (const t of inputs) {
      expect(() => classifyElicitationIntent(t)).not.toThrow();
    }
  });
});
