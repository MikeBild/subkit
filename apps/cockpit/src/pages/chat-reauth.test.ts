import { expect, test } from "bun:test";
import type { ToolPart } from "@/components/ai-elements/tool";
import { chatReauth } from "./chat-reauth";

const origin = "https://engine.example.test";
const id = "5f47b19e-e8ec-42c7-b757-6dd4f1121ac1";
const href = `${origin}/v1/connectors/${id}/oauth/start?grant=test-token`;
const data = { reauth_url: href, expires_at: "2099-01-01T00:00:00Z", connector: "gmail" };
const part = (output: unknown, state = "output-available") =>
  ({
    type: "dynamic-tool",
    toolName: "request_connector_reauth",
    toolCallId: "reauth",
    state,
    input: {},
    output,
  }) as ToolPart;

test("reauth action carries the exact server URL and connection identity", () => {
  for (const output of [data, { ok: true, data }])
    expect(chatReauth(part(output), origin)).toEqual({
      href,
      expiresAt: data.expires_at,
      connectorId: id,
      label: "gmail",
    });
});
test("expired links keep their identity for renewal without claiming successful login", () => {
  expect(
    chatReauth(part({ ...data, expires_at: "2000-01-01T00:00:00Z" }), origin)?.connectorId,
  ).toBe(id);
});
test("does not turn errors, external URLs or malformed results into sign-in buttons", () => {
  for (const output of [
    null,
    {},
    { ok: false, data },
    { ...data, expires_at: "invalid" },
    { ...data, reauth_url: href.replace(origin, "https://attacker.example.test") },
    { ...data, reauth_url: "javascript:alert(1)" },
    { ...data, reauth_url: `${origin}/other?grant=x` },
    { ...data, reauth_url: href.split("?")[0] },
  ])
    expect(chatReauth(part(output), origin)).toBeNull();
  expect(chatReauth(part(data, "output-error"), origin)).toBeNull();
});
