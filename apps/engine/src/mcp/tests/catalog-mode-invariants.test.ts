import { describe, expect, it } from "bun:test";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { listToolsViaRegistry } from "../adapter.ts";
import { type McpMode, modeFlags } from "../mode-resolver.ts";

const principal = { id: "p", tenant_id: "t", scopes: ["*"] } as unknown as ResolvedPrincipal;

const published = (mcpMode: McpMode): Set<string> => {
  const readOnly = !modeFlags(mcpMode, false).showTenantWrites;
  return new Set(listToolsViaRegistry({ principal, mcpMode, readOnly }).map((t) => t.name));
};

describe("MCP catalogue — authoring carries no tenant write but the run tool", () => {
  it("authoring omits direct tenant writes", () => {
    const authoring = published("authoring");
    expect(authoring.has("restore_workflow_version")).toBe(false);
    expect(authoring.has("update_workflow")).toBe(false);
    expect(authoring.has("manage_service_package_skill")).toBe(false);
  });

  it("run_workflow survives in every mode (visible_when_readonly)", () => {
    for (const m of ["product", "authoring", "admin"] as const) {
      expect(published(m).has("run_workflow")).toBe(true);
    }
  });

  it("admin DOES carry the tenant writes authoring withholds", () => {
    const admin = published("admin");
    expect(admin.has("restore_workflow_version")).toBe(true);
    expect(admin.has("update_workflow")).toBe(true);
    expect(admin.has("manage_service_package_skill")).toBe(false);
  });

  it("product ⊂ authoring ⊂ admin", () => {
    const [p, a, ad] = [published("product"), published("authoring"), published("admin")];
    expect(p.size).toBeLessThan(a.size);
    expect(a.size).toBeLessThan(ad.size);
    for (const n of p) expect(a.has(n)).toBe(true);
    for (const n of a) expect(ad.has(n)).toBe(true);
  });
});

describe("MCP catalogue — no draft_write tool is reachable in ANY mode", () => {
  const DRAFT_EDITORS = [
    "edit_workflow_patch",
    "save_workflow_draft",
    "dry_run_workflow",
    "validate_draft",
    "inspect_workflow_draft",
  ];

  for (const m of ["product", "authoring", "admin"] as const) {
    it(`${m} mode omits every draft editor`, () => {
      const listed = published(m);
      for (const t of DRAFT_EDITORS) expect(listed.has(t)).toBe(false);
    });
  }

  it("the chat surface DOES carry them — the omission is MCP-specific", () => {
    const { conversationToolProvider } = require("../../tools/providers/conversation.ts");
    const chat = new Set(
      conversationToolProvider.list({ surface: "chat" }).map((d: { name: string }) => d.name),
    );
    expect(chat.has("edit_workflow_patch")).toBe(true);
  });
});

describe("chat-only tools", () => {
  it("keeps package skill management on the human chat surface", () => {
    for (const mode of ["product", "authoring", "admin"] as const) {
      expect(published(mode).has("manage_service_package_skill")).toBe(false);
    }
    const { conversationToolProvider } = require("../../tools/providers/conversation.ts");
    expect(
      conversationToolProvider
        .list({ surface: "chat" })
        .some((tool: { name: string }) => tool.name === "manage_service_package_skill"),
    ).toBe(true);
  });
});
