// Per-tenant adapter registry.
//
// Adapters are bound to a (tenant, platform, workspace) triple. The
// HTTP route layer pulls an adapter out of this registry before
// calling `verify()`. In production the registry is hydrated from
// `chat_workspaces` at boot; tests register adapters by hand.

import type { ChatAdapter } from "./adapter.ts";
import type { ChatPlatform } from "./types.ts";

export interface AdapterKey {
  tenant_id: string;
  platform: ChatPlatform;
  workspace_id: string;
}

function keyOf(k: AdapterKey): string {
  return `${k.tenant_id}::${k.platform}::${k.workspace_id}`;
}

export class ChatAdapterRegistry {
  private readonly adapters = new Map<string, ChatAdapter>();
  /** Fallback adapter per platform used when the workspace is
   * unknown (e.g. verify happens before we know tenant_id). */
  private readonly fallbackByPlatform = new Map<ChatPlatform, ChatAdapter>();

  register(k: AdapterKey, adapter: ChatAdapter): void {
    this.adapters.set(keyOf(k), adapter);
  }

  registerFallback(platform: ChatPlatform, adapter: ChatAdapter): void {
    this.fallbackByPlatform.set(platform, adapter);
  }

  /** Remove a workspace-specific adapter (used by the workspace-DELETE
   *  route so the in-memory adapter doesn't outlive its DB row, which
   *  would otherwise let outbound traffic continue against a removed
   *  installation). Returns true if a row was removed. */
  unregister(k: AdapterKey): boolean {
    const key = keyOf(k);
    const removed = this.adapters.delete(key);
    // If the removed adapter happened to be the per-platform fallback,
    // promote any remaining adapter of the same platform to fallback
    // so verify still works for that platform. If none remain, drop
    // the fallback too — the route layer will return 503 on the next
    // request, which is correct (nothing installed).
    const fallback = this.fallbackByPlatform.get(k.platform) ?? null;
    if (removed && fallback) {
      // We don't track identity by key, but a freshly-removed adapter
      // would no longer appear in `this.adapters`. If the current
      // fallback can no longer be found among remaining adapters,
      // re-derive.
      const stillRegistered = Array.from(this.adapters.values()).some((a) => a === fallback);
      if (!stillRegistered) {
        const replacement = Array.from(this.adapters.values()).find(
          (a) => a.platform === k.platform,
        );
        if (replacement) this.fallbackByPlatform.set(k.platform, replacement);
        else this.fallbackByPlatform.delete(k.platform);
      }
    }
    return removed;
  }

  get(k: AdapterKey): ChatAdapter | null {
    return this.adapters.get(keyOf(k)) ?? null;
  }

  getFallback(platform: ChatPlatform): ChatAdapter | null {
    return this.fallbackByPlatform.get(platform) ?? null;
  }

  /** Resolve the best adapter to verify an incoming request with,
   * given only the platform. Returns the first fallback then any
   * registered adapter for that platform. */
  findVerifier(platform: ChatPlatform): ChatAdapter | null {
    const fallback = this.fallbackByPlatform.get(platform);
    if (fallback) return fallback;
    for (const adapter of this.adapters.values()) {
      if (adapter.platform === platform) return adapter;
    }
    return null;
  }

  clear(): void {
    this.adapters.clear();
    this.fallbackByPlatform.clear();
  }
}
