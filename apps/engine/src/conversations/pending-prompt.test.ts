import { expect, test } from "bun:test";
import { pendingPrompt } from "./resume.ts";

test("projects a policy question without its execution arguments or approval capability", () => {
  expect(
    pendingPrompt({
      question: "Start sign-in?",
      target: { args: { secret: "hidden" } },
      approval_handle: "hidden",
      approval_url: "hidden",
      commit_intent: { kind: "execute_tool", payload: { secret: "hidden" } },
    }),
  ).toEqual({ prompt: { question: "Start sign-in?", intent_kind: "execute_tool" } });
});
test("projects the provider URL only for a pending OAuth completion", () => {
  const input = {
    question: "Signed in?",
    authorization_url: "https://provider.example/authorize?state=fixture",
    commit_intent: { kind: "oauth_completed" },
  };
  expect(pendingPrompt(input).prompt?.authorization_url).toBe(input.authorization_url);
  for (const url of [
    "javascript:alert(1)",
    "http://provider.example",
    "https://user:password@provider.example",
    "invalid",
  ])
    expect(
      pendingPrompt({ ...input, authorization_url: url }).prompt?.authorization_url,
    ).toBeUndefined();
  expect(
    pendingPrompt({ ...input, commit_intent: { kind: "execute_tool" } }).prompt?.authorization_url,
  ).toBeUndefined();
  expect(pendingPrompt({ question: " " })).toEqual({});
});
