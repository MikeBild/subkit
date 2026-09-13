// Pins what the MCP catalogue actually publishes per mode.
//
// TEST THE PUBLISHED CATALOGUE, NOT THE PROVIDER. `conversationToolProvider.list()`
// is one input to the catalogue, not the catalogue itself: `tools.ts` derives
// `readOnly` from `modeFlags(mode, configReadOnly)` and passes it down, and
// `modeFlags` hardcodes `showTenantWrites: false` for authoring. Querying the
// provider without that flag makes authoring look identical to admin — it is
// not. A round of documentation was written from exactly that mistake and had
// to be withdrawn after a live `tools/list` against production disagreed.
// Reproduce the real path: modeFlags → readOnly → listToolsViaRegistry.

import { describe, expect, it } from "bun:test";

import type { ResolvedPrincipal } from "../../auth/types.ts";
import { listToolsViaRegistry } from "../adapter.ts";
import { type McpMode, modeFlags } from "../mode-resolver.ts";

const principal = { id: "p", tenant_id: "t", scopes: ["*"] } as unknown as ResolvedPrincipal;

/** The catalogue a client actually receives for a mode, assembled the way
 *  `capabilities/tools.ts` assembles it. */
const published = (mcpMode: McpMode): Set<string> => {
  const readOnly = !modeFlags(mcpMode, false).showTenantWrites;
  return new Set(listToolsViaRegistry({ principal, mcpMode, readOnly }).map((t) => t.name));
};

describe("MCP catalogue — authoring carries no tenant write but the run tool", () => {
  it("authoring omits restore_workflow_version and update_workflow", () => {
    // Both are tenant_write. authoring's modeFlags sets showTenantWrites:false,
    // so they never reach the catalogue however broad the credential is.
    const authoring = published("authoring");
    expect(authoring.has("restore_workflow_version")).toBe(false);
    expect(authoring.has("update_workflow")).toBe(false);
  });

  it("run_workflow survives in every mode (visible_when_readonly)", () => {
    // The deliberate exception: running a workflow is a run, not a config
    // mutation, so it stays reachable on a read-only surface. RBAC still gates it.
    for (const m of ["product", "authoring", "admin"] as const) {
      expect(published(m).has("run_workflow")).toBe(true);
    }
  });

  it("admin DOES carry the tenant writes authoring withholds", () => {
    // The modes are not interchangeable. If this ever equalises, the docs that
    // tell authors "a browser client cannot restore a version" become wrong.
    const admin = published("admin");
    expect(admin.has("restore_workflow_version")).toBe(true);
    expect(admin.has("update_workflow")).toBe(true);
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
  // THE invariant the authoring-surface documentation rests on: external
  // clients cannot compose a workflow definition step by step. Every step edit
  // routes through the engine's own authoring loop inside a conversation.
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
    // Guards against "fixing" this by hiding draft_write everywhere, which
    // would break authoring in the REPL and chat.
    const { conversationToolProvider } = require("../../tools/providers/conversation.ts");
    const chat = new Set(
      conversationToolProvider.list({ surface: "chat" }).map((d: { name: string }) => d.name),
    );
    expect(chat.has("edit_workflow_patch")).toBe(true);
  });
});
