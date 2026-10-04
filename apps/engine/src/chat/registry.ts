import type { ChatAdapter } from "./adapter.ts";
import type { ChatDelivery, ChatPlatform, OutboundSendResult } from "./types.ts";

export interface AdapterKey {
  tenant_id: string;
  platform: ChatPlatform;
  workspace_id: string;
}

export interface OutboundFallbackAdapter {
  readonly platform: ChatPlatform;
  send(delivery: ChatDelivery): Promise<OutboundSendResult>;
}

function keyOf(k: AdapterKey): string {
  return `${k.tenant_id}::${k.platform}::${k.workspace_id}`;
}

function isChatAdapter(adapter: OutboundFallbackAdapter): adapter is ChatAdapter {
  return typeof (adapter as ChatAdapter).verify === "function";
}

export class ChatAdapterRegistry {
  private readonly adapters = new Map<string, ChatAdapter>();
  private readonly fallbackByPlatform = new Map<ChatPlatform, OutboundFallbackAdapter>();

  register(k: AdapterKey, adapter: ChatAdapter): void {
    this.adapters.set(keyOf(k), adapter);
  }

  registerFallback(platform: ChatPlatform, adapter: OutboundFallbackAdapter): void {
    this.fallbackByPlatform.set(platform, adapter);
  }

  unregister(k: AdapterKey): boolean {
    const key = keyOf(k);
    const removed = this.adapters.delete(key);
    const fallback = this.fallbackByPlatform.get(k.platform) ?? null;
    if (removed && fallback) {
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
