import { describe, expect, test } from "bun:test";
import { parseAgentFile } from "./agent-file.ts";

describe("parseAgentFile", () => {
  test("normalizes domains and derives the inferred folder domain", () => {
    expect(
      parseAgentFile({
        domains: [" subkit ", " blog-de "],
        inferred: true,
        budget_tokens: 1800,
      }),
    ).toEqual({
      domains: ["subkit", "blog-de"],
      inferred: true,
      inferred_folder_domain: "blog-de",
      budget_tokens: 1800,
    });
  });

  test("uses explicit inferred folder domain and rejects invalid input", () => {
    expect(
      parseAgentFile({
        domains: ["a"],
        inferred: true,
        inferred_folder_domain: " b ",
      }),
    ).toMatchObject({ inferred_folder_domain: "b" });
    expect(() => parseAgentFile({ domains: [] })).toThrow("domains must contain");
    expect(() => parseAgentFile({ domains: ["a"], budget_tokens: 499 })).toThrow("budget_tokens");
    expect(() =>
      parseAgentFile({
        domains: ["a"],
        inferred: true,
        inferred_folder_domain: " ",
      }),
    ).toThrow("inferred_folder_domain");
  });
});

test("domain files reject non-object input and normalize only nonempty strings", () => {
  const callable = Object.assign(() => {}, { domains: ["a"] });
  for (const raw of [
    null,
    undefined,
    false,
    1,
    "a",
    callable,
    {},
    { domains: "a" },
    { domains: [null, 1, false, "", " "] },
  ]) {
    expect(() => parseAgentFile(raw)).toThrow("domains must contain at least one domain slug");
  }
  expect(parseAgentFile({ domains: [null, 1, "", " ", " a ", " b "] })).toStrictEqual({
    domains: ["a", "b"],
  });
});

test("briefing budget accepts both inclusive limits and rejects invalid numbers", () => {
  for (const budget of [500, 16000])
    expect(parseAgentFile({ domains: ["a"], budget_tokens: budget })).toStrictEqual({
      domains: ["a"],
      budget_tokens: budget,
    });
  for (const budget of [16001, 1.5, NaN, Infinity, null, "500"])
    expect(() => parseAgentFile({ domains: ["a"], budget_tokens: budget })).toThrow(
      "budget_tokens",
    );
  expect(parseAgentFile({ domains: ["a"] })).toStrictEqual({ domains: ["a"] });
});

test("inference is opt-in and preserves explicit or derived folder ownership", () => {
  for (const inferred of [false, undefined, "true", 1]) {
    expect(
      parseAgentFile({ domains: ["subkit"], inferred, inferred_folder_domain: 42 }),
    ).toStrictEqual({ domains: ["subkit"] });
  }
  for (const inferred_folder_domain of [null, undefined]) {
    expect(
      parseAgentFile({ domains: ["subkit"], inferred: true, inferred_folder_domain }),
    ).toStrictEqual({ domains: ["subkit"], inferred: true, inferred_folder_domain: null });
  }
  expect(
    parseAgentFile({ domains: ["subkit", "blog"], inferred: true, inferred_folder_domain: null }),
  ).toStrictEqual({ domains: ["subkit", "blog"], inferred: true, inferred_folder_domain: "blog" });
  for (const domain of [false, 1, "", " "])
    expect(() =>
      parseAgentFile({ domains: ["a"], inferred: true, inferred_folder_domain: domain }),
    ).toThrow("inferred_folder_domain");
});
