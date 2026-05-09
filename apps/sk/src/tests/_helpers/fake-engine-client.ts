// Drop-in test double for `EngineClient`.
//
// Provides only the surface the REPL + tests touch directly. Methods
// either resolve with canned data injected at construction or throw
// when a missing case isn't configured (so tests fail loudly rather
// than silently returning undefined).

import type { ResolvedProfile } from "../../config.ts";
import type { ConversationDetail, ConversationSummary, EngineClient } from "../../engine-client.ts";

export interface FakeEngineClientOptions {
  whoami?: {
    id: string;
    kind: "user" | "system_account";
    tenant_id: string;
    tenant_slug: string | null;
    email: string | null;
    role_name: string | null;
    provider: string;
  };
  bootstrap?: {
    permissions?: readonly string[];
    permissions_checked?: readonly string[];
    recent_sessions?: ReadonlyArray<{ id: string; title: string | null; updated_at: string }>;
    flags?: Record<string, boolean>;
  };
  rbacAllow?: (permission: string) => boolean;
  conversations?: ConversationSummary[];
  conversationDetail?: ConversationDetail;
  errorOnBootstrap?: Error;
}

const DEFAULT_WHOAMI = {
  id: "u-fake",
  kind: "user" as const,
  tenant_id: "t-fake",
  tenant_slug: "t-fake",
  email: "fake@test.local",
  role_name: "operator",
  provider: "api_key",
};

const ALL_UX_PERMS: readonly string[] = [
  "conversation:read",
  "conversation:write",
  "memory:write",
  "conversation:approve",
  "conversation:list",
  "mcp:read",
  "skill:read",
  "conversation:cancel",
  "conversation:commit",
  "workflow:read",
  "workflow:write",
  "connector:read",
  "skill:write",
  "execution:read",
  "notification:read",
  "audit:read",
  "identity:read",
  "rbac:read",
  "api_key:read",
  "portal_token:read",
  "knowledge:read",
];

export function createFakeEngineClient(opts: FakeEngineClientOptions = {}): EngineClient {
  const whoami = opts.whoami ?? DEFAULT_WHOAMI;
  const calls = {
    bootstrap: 0,
    whoami: 0,
    rbacCan: 0,
  };
  // Use loose typing internally; the entire fake is cast to EngineClient
  // at the return site, so the structural mismatch on `kind` (the real
  // client narrows to "user" in some paths) is intentional for tests.
  const fake = {
    _calls: calls,
    skBootstrap(): Promise<unknown> {
      calls.bootstrap++;
      if (opts.errorOnBootstrap) return Promise.reject(opts.errorOnBootstrap);
      const perms = (opts.bootstrap?.permissions ?? ALL_UX_PERMS).slice();
      const checked = (opts.bootstrap?.permissions_checked ?? ALL_UX_PERMS).slice();
      const recent = (opts.bootstrap?.recent_sessions ?? []).map((r) => ({ ...r }));
      return Promise.resolve({
        whoami: { ...whoami, base_url: null, scopes: null },
        permissions: perms,
        permissions_checked: checked,
        tenant: { id: whoami.tenant_id, slug: whoami.tenant_slug, display_name: null },
        recent_sessions: recent,
        flags: opts.bootstrap?.flags ?? {},
        // H1 of #159 follow-up — engine-resolved prefs.
        prefs: {
          permissionMode: "ask" as const,
          theme: "auto" as const,
          personality: "balanced" as const,
          titleFormat: "session-id" as const,
          statuslineFormat: "compact" as const,
          pushNotifyEnabled: false,
          pushNotifyThresholdSec: 30,
          quietHoursStart: "",
          quietHoursEnd: "",
        },
        server_time: new Date().toISOString(),
      });
    },
    whoami(): Promise<unknown> {
      calls.whoami++;
      return Promise.resolve(whoami);
    },
    rbacCan(body: { permission: string }): Promise<{
      allow: boolean;
      source: string | null;
      reason: string | null;
    }> {
      calls.rbacCan++;
      const allow = opts.rbacAllow ? opts.rbacAllow(body.permission) : true;
      return Promise.resolve({ allow, source: "fake", reason: null });
    },
    listConversations(): Promise<{ items: ConversationSummary[] }> {
      return Promise.resolve({ items: opts.conversations ?? [] });
    },
    getConversation(): Promise<ConversationDetail> {
      if (!opts.conversationDetail) return Promise.reject(new Error("no conversationDetail set"));
      return Promise.resolve(opts.conversationDetail);
    },
  };
  return fake as unknown as EngineClient;
}

export const ANONYMOUS_PROFILE: ResolvedProfile = {
  name: "default",
  engine_url: "http://localhost:5050",
  api_key: "wf_live_fake",
  active_tenant_id: "t-fake",
  persona_hint: "operator",
  portal_locked: false,
};

export function fakeClientCallCounts(client: EngineClient): {
  bootstrap: number;
  whoami: number;
  rbacCan: number;
} {
  return (client as unknown as { _calls: { bootstrap: number; whoami: number; rbacCan: number } })
    ._calls;
}
