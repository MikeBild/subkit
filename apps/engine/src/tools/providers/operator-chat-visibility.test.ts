import { expect, test } from "bun:test";
import { listTools } from "../../conversations/tools/index.ts";
import { OPERATOR_PERMISSIONS } from "../../rbac/catalog.ts";
import { conversationToolProvider } from "./conversation.ts";
import { staticToolProvider } from "./static.ts";

const ENGINE_WIDE_NAME = /setting|secret|restart/i;

function chatDescriptors() {
  return [
    ...staticToolProvider.list({ surface: "chat" }),
    ...conversationToolProvider.list({ surface: "chat" }),
  ];
}

test("no chat tool is gated by an engine-wide permission", () => {
  expect(OPERATOR_PERMISSIONS.size).toBeGreaterThan(0);
  expect(chatDescriptors().some((tool) => tool.rbac !== undefined)).toBe(true);
  const engineGated = chatDescriptors()
    .filter((tool) => tool.rbac && OPERATOR_PERMISSIONS.has(tool.rbac.permission))
    .map((tool) => `${tool.name}:${tool.rbac?.permission}`);
  expect(engineGated).toEqual([]);
});

test("no conversation tool declares an engine-wide permission on any surface", () => {
  expect(listTools().some((tool) => tool.permission !== undefined)).toBe(true);
  const engineGated = listTools()
    .filter((tool) => tool.permission && OPERATOR_PERMISSIONS.has(tool.permission.action))
    .map((tool) => tool.name);
  expect(engineGated).toEqual([]);
});

test("no engine-wide settings, secret or restart tool is reachable from chat by name", () => {
  expect(chatDescriptors().filter((tool) => ENGINE_WIDE_NAME.test(tool.name))).toEqual([]);
});
