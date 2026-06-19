// Per-tenant adapter registry.
//
// Adapters are bound to a (tenant, platform, workspace) triple. The
// HTTP route layer pulls an adapter out of this registry before
// calling `verify()`. In production the registry is hydrated from
// `chat_workspaces` at boot; tests register adapters by hand.

import type { ChatAdapter } from "./adapter.ts";
import type { ChatDelivery, ChatPlatform } from "./types.ts";

export interface AdapterKey {
  tenant_id: string;
  platform: ChatPlatform;
  workspace_id: string;
}

/**
 * Outbound-only fallback adapter. A full `ChatAdapter` satisfies it, as
 * does the notification-only `SkCliAdapter` which implements just
 * `platform` + `send` (no inbound verify/receive — the `sk_cli`
 * pseudo-platform never ingests). The registry stores fallbacks under
 * this widened type; `findVerifier` narrows back to real `ChatAdapter`s
 * since only those can verify inbound requests.
 */
export interface OutboundFallbackAdapter {
  readonly platform: ChatPlatform;
  send(delivery: ChatDelivery): Promise<{ platform_message_id: string }>;
}

function keyOf(k: AdapterKey): string {
  return `${k.tenant_id}::${k.platform}::${k.workspace_id}`;
}

/** A full `ChatAdapter` can verify inbound requests; an outbound-only
 *  fallback (e.g. `SkCliAdapter`) cannot. The presence of `verify`
 *  distinguishes the two. */
function isChatAdapter(adapter: OutboundFallbackAdapter): adapter is ChatAdapter {
  return typeof (adapter as ChatAdapter).verify === "function";
}

export class ChatAdapterRegistry {
  private readonly adapters = new Map<string, ChatAdapter>();
  /** Fallback adapter per platform used when the workspace is
   * unknown (e.g. verify happens before we know tenant_id) or when a
   * platform is never installed per workspace (`sk_cli` is a single
   * process-global outbound sink). */
  private readonly fallbackByPlatform = new Map<ChatPlatform, OutboundFallbackAdapter>();

  register(k: AdapterKey, adapter: ChatAdapter): void {
    this.adapters.set(keyOf(k), adapter);
  }

  registerFallback(platform: ChatPlatform, adapter: OutboundFallbackAdapter): void {
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

  getFallback(platform: ChatPlatform): OutboundFallbackAdapter | null {
    return this.fallbackByPlatform.get(platform) ?? null;
  }

  /** Resolve the best adapter to verify an incoming request with,
   * given only the platform. Returns the first fallback then any
   * registered adapter for that platform. Only full `ChatAdapter`s can
   * verify inbound requests, so outbound-only fallbacks (e.g. `sk_cli`)
   * are excluded — they never appear on an inbound ingestion path. */
  findVerifier(platform: ChatPlatform): ChatAdapter | null {
    const fallback = this.fallbackByPlatform.get(platform);
    if (fallback && isChatAdapter(fallback)) return fallback;
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
