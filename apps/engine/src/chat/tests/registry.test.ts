// Unit test for ChatAdapterRegistry — exercises the fallback
// re-derivation when an unregister removes the per-platform fallback.
// Pure in-memory, no DB.

import { describe, expect, test } from "bun:test";
import type { ChatAdapter } from "../adapter.ts";
import { ChatAdapterRegistry } from "../registry.ts";
import type {
  ApprovalCard,
  ChatDelivery,
  ChatEvent,
  ChatPlatform,
  VerifiedEvent,
} from "../types.ts";

function makeFakeAdapter(platform: ChatPlatform = "slack"): ChatAdapter {
  return {
    platform,
    verify: async () => null as VerifiedEvent | null,
    receive: async (ev: VerifiedEvent) => ev as unknown as ChatEvent,
    send: async (_: ChatDelivery) => ({ platform_message_id: "m" }),
    update: async () => {},
    sendApproval: async (_: ApprovalCard) => ({ platform_message_id: "ap" }),
  };
}

describe("ChatAdapterRegistry.unregister", () => {
  test("removing the fallback adapter re-promotes another adapter of the same platform", () => {
    const r = new ChatAdapterRegistry();
    const a = makeFakeAdapter();
    const b = makeFakeAdapter();
    r.register({ tenant_id: "t1", platform: "slack", workspace_id: "T_A" }, a);
    r.register({ tenant_id: "t2", platform: "slack", workspace_id: "T_B" }, b);
    r.registerFallback("slack", a);
    expect(r.findVerifier("slack")).toBe(a);

    r.unregister({ tenant_id: "t1", platform: "slack", workspace_id: "T_A" });
    // Fallback was `a` but `a` is gone; b should be promoted.
    expect(r.findVerifier("slack")).toBe(b);
  });

  test("removing the only adapter clears the fallback", () => {
    const r = new ChatAdapterRegistry();
    const a = makeFakeAdapter();
    r.register({ tenant_id: "t1", platform: "slack", workspace_id: "T_A" }, a);
    r.registerFallback("slack", a);
    expect(r.findVerifier("slack")).toBe(a);

    r.unregister({ tenant_id: "t1", platform: "slack", workspace_id: "T_A" });
    expect(r.findVerifier("slack")).toBeNull();
  });

  test("removing a non-fallback adapter leaves the fallback intact", () => {
    const r = new ChatAdapterRegistry();
    const a = makeFakeAdapter();
    const b = makeFakeAdapter();
    r.register({ tenant_id: "t1", platform: "slack", workspace_id: "T_A" }, a);
    r.register({ tenant_id: "t2", platform: "slack", workspace_id: "T_B" }, b);
    r.registerFallback("slack", a);

    r.unregister({ tenant_id: "t2", platform: "slack", workspace_id: "T_B" });
    expect(r.findVerifier("slack")).toBe(a);
  });
});
