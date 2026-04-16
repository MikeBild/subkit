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
