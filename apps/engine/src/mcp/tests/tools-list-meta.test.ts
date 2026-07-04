// Every subkit conversation tool rendered into `tools/list` carries a
// `_meta.subkit` envelope (category + confirm/destructive hints) so
// clients can show destructive hints and skip self-authored pre-confirms.
// The envelope is built by `buildConversationToolMeta`, which the MCP
// adapter (`descriptorToMcpTool`) applies to every bare-name tool. This
// test pins that builder directly — the same contract the (now removed)
// tenant.* alias path used to assert.

import { describe, expect, it } from "bun:test";
import { buildConversationToolMeta } from "../capabilities/tool-meta.ts";

describe("MCP tool listing _meta.subkit", () => {
  it("flags delete_workflow as confirm_required + destructive", () => {
    const meta = buildConversationToolMeta("tenant_write", "delete_workflow").subkit;
    expect(meta).toEqual({
      category: "tenant_write",
      confirm_required: true,
      destructive: true,
    });
  });

  it("leaves list_workflows as a plain read", () => {
    const meta = buildConversationToolMeta("tenant_read", "list_workflows").subkit;
    expect(meta).toEqual({
      category: "tenant_read",
      confirm_required: false,
      destructive: false,
    });
  });

  it("flags revoke_api_key as confirm_required + destructive", () => {
    const meta = buildConversationToolMeta("tenant_write", "revoke_api_key").subkit;
    expect(meta.confirm_required).toBe(true);
    expect(meta.destructive).toBe(true);
  });
});
