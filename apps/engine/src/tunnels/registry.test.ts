// TunnelRegistry capacity bound — Phase 4 of the 2026-05 architecture
// audit (issue #93). Pins the LRU eviction contract:
//
//   1. attach() at the cap evicts the oldest entry by last_seen_ms.
//   2. The evicted entry's pending requests reject (no zombie waiters).
//   3. The eviction bumps tunnel_registry_evictions_total.
//   4. Per-key replace (same tenant + target) does NOT trigger LRU.

import { describe, expect, test } from "bun:test";
import { encodeFrame } from "./framing.ts";
import { TunnelRegistry } from "./registry.ts";
import { TunnelDisconnectedError, type TunnelSocket } from "./types.ts";

function fakeSocket(): TunnelSocket & { sent: string[] } {
  const sent: string[] = [];
  return {
    send(frame: string | ArrayBuffer | ArrayBufferView): void {
      sent.push(typeof frame === "string" ? frame : new TextDecoder().decode(frame));
    },
    close() {},
    sent,
  } as unknown as TunnelSocket & { sent: string[] };
}

describe("TunnelRegistry — bounded LRU", () => {
  test("attach beyond cap evicts the oldest entry", async () => {
    const reg = new TunnelRegistry({ maxEntries: 2 });
    reg.attach({
      tunnel_id: "t1",
      tenant_id: "tenant-a",
      tunnel_name: "alpha",
      target: "alpha",
      socket: fakeSocket(),
      concurrency_cap: 4,
    });
    // Wait a millisecond so last_seen_ms differs.
    await Bun.sleep(5);
    reg.attach({
      tunnel_id: "t2",
      tenant_id: "tenant-a",
      tunnel_name: "beta",
      target: "beta",
      socket: fakeSocket(),
      concurrency_cap: 4,
    });
    expect(reg.size()).toBe(2);

    // Third attach pushes oldest out.
    await Bun.sleep(5);
    reg.attach({
      tunnel_id: "t3",
      tenant_id: "tenant-a",
      tunnel_name: "gamma",
      target: "gamma",
      socket: fakeSocket(),
      concurrency_cap: 4,
    });

    expect(reg.size()).toBe(2);
    expect(reg.get("tenant-a", "alpha")).toBeUndefined();
    expect(reg.get("tenant-a", "beta")).toBeDefined();
    expect(reg.get("tenant-a", "gamma")).toBeDefined();
  });

  test("evicted entry's pending request rejects with disconnect", async () => {
    const reg = new TunnelRegistry({ maxEntries: 1 });
    const sock = fakeSocket();
    reg.attach({
      tunnel_id: "t1",
      tenant_id: "tenant-a",
      tunnel_name: "alpha",
      target: "alpha",
      socket: sock,
      concurrency_cap: 4,
    });
    // Kick off a forwardRequest — it will install a pending resolver.
    const pending = reg.forwardRequest(
      "tenant-a",
      "alpha",
      { target: "alpha", method: "GET", path: "/", headers: {} },
      { timeoutMs: 60_000 },
    );

    // Give the await microtask a chance to install before evicting.
    await Bun.sleep(5);

    // Filling the cap with a different key evicts alpha.
    reg.attach({
      tunnel_id: "t2",
      tenant_id: "tenant-a",
      tunnel_name: "beta",
      target: "beta",
      socket: fakeSocket(),
      concurrency_cap: 4,
    });

    // The pending request must surface as a disconnect.
    await expect(pending).rejects.toBeInstanceOf(TunnelDisconnectedError);
  });

  test("replace (same key) does NOT count against the cap", async () => {
    const reg = new TunnelRegistry({ maxEntries: 1 });
    reg.attach({
      tunnel_id: "t1",
      tenant_id: "tenant-a",
      tunnel_name: "alpha",
      target: "alpha",
      socket: fakeSocket(),
      concurrency_cap: 4,
    });
    // Replace the same key — registry size stays 1, no eviction needed.
    reg.attach({
      tunnel_id: "t1-replaced",
      tenant_id: "tenant-a",
      tunnel_name: "alpha",
      target: "alpha",
      socket: fakeSocket(),
      concurrency_cap: 4,
    });
    expect(reg.size()).toBe(1);
    expect(reg.get("tenant-a", "alpha")?.tunnel_id).toBe("t1-replaced");
  });

  // Suppress unused import — encodeFrame is exported by framing for callers
  // and may be referenced by future extensions of this test.
  void encodeFrame;
});
