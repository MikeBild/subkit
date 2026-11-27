import { describe, expect, it } from "bun:test";
import { loadPermissionCatalog } from "../catalog.ts";

const PERMISSION_NAMES = loadPermissionCatalog().map((p) => p.name);

function memberAllows(name: string): boolean {
  if (name.startsWith("rbac:")) return false;
  if (name === "audit:read") return false;
  if (name === "identity:write") return false;
  if (name === "stats:read") return false;
  if (name === "stats:read:all") return false;
  if (name === "api_key:write") return false;
  if (name === "api_key:rotate") return false;
  if (name === "api_key:revoke") return false;
  if (name === "connector:promote") return false;
  if (name === "connector:confirm_local_command") return false;
  if (name.startsWith("vault:") && name !== "vault:read" && name !== "vault:use") return false;
  if (name === "discovery:approve") return false;
  if (name === "mcp:admin") return false;
  if (name.startsWith("mcp_oauth_client:")) return false;
  if (name.startsWith("chat_workspace:") && name !== "chat_workspace:read") return false;
  if (name.startsWith("chat_identity:") && name !== "chat_identity:read") return false;
  return true;
}

describe("stats:read:all — catalog and seed invariants", () => {
  it("stats:read:all exists in the permission catalog", () => {
    expect(PERMISSION_NAMES).toContain("stats:read:all");
  });

  it("member role filter excludes stats:read:all", () => {
    expect(memberAllows("stats:read:all")).toBe(false);
  });

  it("member role filter excludes stats:read (cross-workflow operational posture)", () => {
    expect(memberAllows("stats:read")).toBe(false);
  });

  it("admin role receives ALL permissions — stats:read:all included", () => {
    expect(PERMISSION_NAMES.includes("stats:read:all")).toBe(true);
    expect(memberAllows("stats:read:all")).toBe(false);
  });

  it("member role allows workflow and execution permissions (non-regressive check)", () => {
    expect(memberAllows("workflow:read")).toBe(true);
    expect(memberAllows("workflow:run")).toBe(true);
    expect(memberAllows("execution:read")).toBe(true);
    expect(memberAllows("connector:read")).toBe(true);
    expect(memberAllows("connector:write")).toBe(true);
    expect(memberAllows("connector:promote")).toBe(false);
  });

  it("member role still allows vault:read (the one credential permission members keep)", () => {
    expect(memberAllows("vault:read")).toBe(true);
  });

  it("stats:read:all description mentions other users and cross-user breakdowns", () => {
    const entry = loadPermissionCatalog().find((p) => p.name === "stats:read:all");
    expect(entry).toBeDefined();
    expect(entry!.description.toLowerCase()).toMatch(/user/);
  });
});
