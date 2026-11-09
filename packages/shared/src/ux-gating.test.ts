import { expect, test } from "bun:test";
import { UX_GATING_PERMISSIONS } from "./ux-gating.ts";

test("bootstrap permission vocabulary matches the published client response contract", () => {
  expect(UX_GATING_PERMISSIONS).toEqual([
    "conversation:read",
    "conversation:write",
    "memory:write",
    "conversation:approve",
    "conversation:list",
    "mcp:read",
    "skill:read",
    "conversation:cancel",
    "conversation:commit",
    "workflow:read",
    "workflow:write",
    "connector:read",
    "connector:write",
    "chat_workspace:read",
    "chat_workspace:write",
    "skill:write",
    "execution:read",
    "notification:read",
    "notification:write",
    "discovery:read",
    "file:read",
    "file:write",
    "file:delete",
    "audit:read",
    "identity:read",
    "rbac:read",
    "api_key:read",
    "portal_token:read",
    "package:import",
    "knowledge:read",
    "intake:read",
    "stats:read:all",
  ]);
});
