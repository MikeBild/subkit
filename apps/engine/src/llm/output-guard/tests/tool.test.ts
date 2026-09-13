// Unit tests for the tool-ref scanner.

import { describe, expect, it } from "bun:test";

import { toolScanner } from "../scanners/tool.ts";

const ctx = {};

describe("toolScanner", () => {
  it("ignores plain prose with no backticks", () => {
    expect(toolScanner.scan("I will create an API key for you.", ctx)).toEqual([]);
  });

  it("passes when narrating a real tool by name", () => {
    expect(toolScanner.scan("I will call `create_api_key` next.", ctx)).toEqual([]);
  });

  it("flags a phantom tool reference (the original transcript bug shape)", () => {
    // RC1: the verb must immediately precede the backtick (within ~40 chars,
    // no intervening noun). "prompting `phantom`" matches; "prompted a `x`"
    // does not because " a " breaks the verb→backtick adjacency.
    const vs = toolScanner.scan("I've prompting `prompt_form_for_user` to collect details.", ctx);
    expect(vs.map((v) => v.kind)).toContain("tool.phantom_reference");
    expect(vs[0]?.details?.invented_tool).toBe("prompt_form_for_user");
  });

  it("ignores backticked single-word tokens (e.g. `json`)", () => {
    expect(toolScanner.scan("Returns a `json` payload.", ctx)).toEqual([]);
  });

  it("ignores backticked types and primitives", () => {
    expect(toolScanner.scan("The result is `string` or `null`.", ctx)).toEqual([]);
  });

  it("ignores known runtime-context placeholders", () => {
    expect(toolScanner.scan("Use `engine_url` and `plaintext_key`.", ctx)).toEqual([]);
  });

  it("flags multiple phantom tools in one block", () => {
    // RC1: only tokens preceded by an invocation verb are flagged.
    // "call `make_api_key_for_user`" → 1 violation; the trailing tokens
    // with no invocation verb before them are legitimate references and
    // are not flagged. Use a text where each phantom has an explicit verb.
    const text =
      "First I'll call `make_api_key_for_user`, then invoke `attach_to_chat_session`, finally running `confirm_with_dialog_now`.";
    const vs = toolScanner.scan(text, ctx);
    expect(vs.length).toBeGreaterThanOrEqual(3);
  });

  it("does not flag a substring of a real tool name (no fuzzy matching here)", () => {
    // create_api_key is real, but `api_key` alone is not — and we want
    // to allow plain-prose mention of the concept. Backticked + short
    // (len<4 or no underscore) → skipped.
    expect(toolScanner.scan("Use the `key`.", ctx)).toEqual([]);
  });
});
