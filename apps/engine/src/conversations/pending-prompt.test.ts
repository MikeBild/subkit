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
test("says that a question releases held changes without exposing the approval it is bound to", () => {
  expect(
    pendingPrompt({
      question: "Send the reminder?",
      commit_intent: {
        kind: "execute_confirmed_tool_call",
        payload: { approval_id: "0e7d371c-6240-4832-a335-2178652ba344" },
      },
    }),
  ).toEqual({
    prompt: {
      question: "Send the reminder?",
      intent_kind: "execute_confirmed_tool_call",
      approval_backed: true,
    },
  });
});
test("projects a gated connector call's effect so a reader can phrase it in their language", () => {
  const effect = {
    connector: "Reporting API",
    method: "PATCH",
    target: "https://api.example/v1/x",
  };
  expect(
    pendingPrompt({
      question: "Reporting API: PATCH https://api.example/v1/x — approve this call?",
      effect,
      commit_intent: { kind: "execute_confirmed_tool_call" },
    }).prompt,
  ).toEqual({
    question: "Reporting API: PATCH https://api.example/v1/x — approve this call?",
    intent_kind: "execute_confirmed_tool_call",
    effect,
  });
  expect(
    pendingPrompt({ question: "Continue?", effect: { connector: "", method: "GET" } }).prompt
      ?.effect,
  ).toBeUndefined();
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

test("a card payment confirmation carries its payment id for the approval panel", () => {
  const device = {
    device_id: "dev-1",
    capability: "browser",
    target: "pay · https://shop.example.com · €12.34 · Visa •••• 4242",
    deadline_at: "2030-01-01T00:00:00.000Z",
    command_id: null,
    binding_hash: null,
  };
  const payment_id = "6f1c2b9e-4a7d-4c1e-9b3a-2d5e8f7a1c04";
  const pay = pendingPrompt(
    {
      kind: "local_confirmation",
      question: "Should SubKit do this on your device?",
      target: { tool: "browser_pay", args: { origin: "https://shop.example.com", payment_id } },
      device,
    },
    "ask_user_confirm",
  );
  expect(pay.prompt?.payment_id).toBe(payment_id);
  const signIn = pendingPrompt(
    {
      kind: "local_confirmation",
      question: "Should SubKit do this on your device?",
      target: { tool: "browser_sign_in", args: { origin: "https://shop.example.com" } },
      device,
    },
    "ask_user_confirm",
  );
  expect(signIn.prompt?.payment_id).toBeUndefined();
  expect(signIn.prompt?.device?.device_id).toBe("dev-1");
});
