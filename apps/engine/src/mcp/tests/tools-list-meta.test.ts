// Every subkit tool in `tools/list` must carry a `_meta.subkit`
// envelope so clients can show destructive hints and skip
// self-authored pre-confirms.

import { describe, expect, it } from "bun:test";
import { listTenantTools } from "../capabilities/tenant-tools.ts";

type Subkit = { category: string; confirm_required: boolean; destructive: boolean };
type WithMeta = { name: string; _meta?: { subkit?: Subkit } };

describe("MCP tool listing _meta.subkit", () => {
  it("flags tenant.delete_workflow as confirm_required + destructive", () => {
    const tools = listTenantTools({ allowWrites: true }) as WithMeta[];
    const del = tools.find((t) => t.name === "tenant.delete_workflow");
    expect(del).toBeDefined();
    expect(del?._meta?.subkit).toEqual({
      category: "tenant_write",
      confirm_required: true,
      destructive: true,
    });
  });

  it("leaves tenant.list_workflows as a plain read", () => {
    const tools = listTenantTools({ allowWrites: true }) as WithMeta[];
    const list = tools.find((t) => t.name === "tenant.list_workflows");
    expect(list).toBeDefined();
    expect(list?._meta?.subkit).toEqual({
      category: "tenant_read",
      confirm_required: false,
      destructive: false,
    });
  });

  it("flags revoke_api_key as confirm_required even though not destructive-prefixed", () => {
    const tools = listTenantTools({ allowWrites: true }) as WithMeta[];
    const rev = tools.find((t) => t.name === "tenant.revoke_api_key");
    expect(rev).toBeDefined();
    expect(rev?._meta?.subkit?.confirm_required).toBe(true);
    expect(rev?._meta?.subkit?.destructive).toBe(true);
  });
});
