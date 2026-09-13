// Profile tab — read-only identity card from skBootstrap plus an
// inline action menu.
//
// Actions:
//   n  Start a new session  (clears the active conversation id)
//   t  Switch tenant         (writes config.active_tenant_id; restart applies)
//   s  Sign out              (clears the api_key in config; restart applies)
//
// Actions that mutate the on-disk profile use `saveProfile()` and emit
// a "restart sk to apply" notice — the running REPL holds the previous
// session state and can't be re-bootstrapped from inside the modal.

import { Box, Text, useInput } from "ink";
import type React from "react";
import { useEffect, useState } from "react";

import { configPath, loadConfig, type ResolvedProfile, saveProfile } from "../../config.ts";
import type { EngineClient } from "../../engine-client.ts";

interface Props {
  client: EngineClient;
  /**
   * Optional action sink — when supplied, the tab forwards declarative
   * action requests to the host (ink-app.tsx) which has access to
   * session state. When omitted (e.g. running inside the standalone
   * `sk settings` CLI), the tab still writes config but skips actions
   * that need REPL-runtime cooperation.
   */
  onAction?: (action: ProfileAction) => void;
  /**
   * Fired when this tab "owns Esc" — see ConfigTab for the contract.
   * ProfileTab owns Esc while the tenant picker is open so the outer
   * shell (SinglePane / SettingsModal) doesn't dismiss the pane on
   * the same Esc keystroke that closes the picker.
   */
  onInnerEscape?: (active: boolean) => void;
}

export type ProfileAction =
  { kind: "new-session" } | { kind: "switch-tenant"; tenant_id: string } | { kind: "sign-out" };

interface IdentitySnapshot {
  email: string | null;
  tenantSlug: string | null;
  tenantId: string;
  role: string | null;
  provider: string;
  baseUrl: string | null;
  serverTime: string;
}

interface TenantRow {
  id: string;
  slug: string | null;
  display_name: string | null;
}

export const ProfileTab: React.FC<Props> = ({ client, onAction, onInnerEscape }) => {
  const [snap, setSnap] = useState<IdentitySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tenantList, setTenantList] = useState<TenantRow[]>([]);
  const [tenantPickerOpen, setTenantPickerOpen] = useState(false);
  const [tenantIdx, setTenantIdx] = useState(0);
  const [flash, setFlash] = useState<{ kind: "ok" | "error"; msg: string } | null>(null);

  useEffect(() => {
    onInnerEscape?.(tenantPickerOpen);
  }, [tenantPickerOpen, onInnerEscape]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const b = await client.skBootstrap();
        if (cancelled) return;
        setSnap({
          email: b.whoami.email,
          tenantSlug: b.tenant.slug ?? b.whoami.tenant_slug,
          tenantId: b.tenant.id,
          role: b.whoami.role_name,
          provider: b.whoami.provider,
          baseUrl: b.whoami.base_url,
          serverTime: b.server_time,
        });
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  const fetchTenants = async (): Promise<void> => {
    try {
      const res = await client.listIdentityTenants();
      const rows: TenantRow[] = res.items.map((it) => ({
        id: typeof it.id === "string" ? it.id : "(unknown)",
        slug: typeof it.slug === "string" ? it.slug : null,
        display_name: typeof it.display_name === "string" ? it.display_name : null,
      }));
      setTenantList(rows);
    } catch (err) {
      setFlash({
        kind: "error",
        msg: `tenant list failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  // Defer the disk I/O off the render thread via `queueMicrotask`
  // so a slow mount or antivirus hook on `~/.sk/config.json` doesn't
  // hitch Ink's reconciler. The function still returns the updated
  // profile synchronously to the caller — the disk write happens on
  // the next microtask tick. `loadConfig` / `saveProfile` remain
  // sync because every other caller in the CLI assumes synchronous
  // semantics; switching this single call site is the lowest-cost
  // mitigation.
  const persistTenant = (tenant_id: string): ResolvedProfile | null => {
    try {
      const cfg = loadConfig();
      const profileName = cfg.active_profile;
      const profile = cfg.profiles[profileName];
      if (!profile) {
        setFlash({ kind: "error", msg: `active profile "${profileName}" not found in config` });
        return null;
      }
      const updated: ResolvedProfile = {
        name: profileName,
        engine_url: profile.engine_url,
        api_key: profile.api_key,
        active_tenant_id: tenant_id,
        ...(profile.persona_hint ? { persona_hint: profile.persona_hint } : {}),
        ...(profile.portal_locked ? { portal_locked: profile.portal_locked } : {}),
      };
      queueMicrotask(() => {
        try {
          saveProfile(updated, configPath());
        } catch (err) {
          setFlash({
            kind: "error",
            msg: `saveProfile failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      });
      return updated;
    } catch (err) {
      setFlash({
        kind: "error",
        msg: `loadConfig failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return null;
    }
  };

  const persistSignOut = (): boolean => {
    try {
      const cfg = loadConfig();
      const profileName = cfg.active_profile;
      const profile = cfg.profiles[profileName];
      if (!profile) {
        setFlash({ kind: "error", msg: `active profile "${profileName}" not found` });
        return false;
      }
      const updated: ResolvedProfile = {
        name: profileName,
        engine_url: profile.engine_url,
        api_key: "",
        active_tenant_id: profile.active_tenant_id,
      };
      saveProfile(updated, configPath());
      return true;
    } catch (err) {
      setFlash({
        kind: "error",
        msg: `saveProfile failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return false;
    }
  };

  useInput((input, key) => {
    if (tenantPickerOpen) {
      if (key.escape) {
        setTenantPickerOpen(false);
        return;
      }
      if (key.upArrow) {
        setTenantIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setTenantIdx((i) => Math.min(tenantList.length - 1, i + 1));
        return;
      }
      if (key.return) {
        const sel = tenantList[tenantIdx];
        if (!sel) return;
        const updated = persistTenant(sel.id);
        if (updated) {
          setFlash({
            kind: "ok",
            msg: `tenant set to ${sel.slug ?? sel.id} — restart sk to apply`,
          });
          onAction?.({ kind: "switch-tenant", tenant_id: sel.id });
        }
        setTenantPickerOpen(false);
        return;
      }
      return;
    }
    if (input === "n") {
      onAction?.({ kind: "new-session" });
      setFlash({ kind: "ok", msg: "started a new session — type your next prompt" });
      return;
    }
    if (input === "t") {
      setTenantPickerOpen(true);
      void fetchTenants();
      return;
    }
    if (input === "s") {
      const ok = persistSignOut();
      if (ok) {
        setFlash({ kind: "ok", msg: "signed out — api_key cleared; restart sk to log in again" });
        onAction?.({ kind: "sign-out" });
      }
      return;
    }
  });

  if (error) {
    return (
      <Box flexDirection="column">
        <Text bold>Profile</Text>
        <Text color="red">failed to load identity: {error}</Text>
      </Box>
    );
  }
  if (!snap) {
    return (
      <Box flexDirection="column">
        <Text bold>Profile</Text>
        <Text>loading…</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold>Profile</Text>
      <Box marginTop={1} flexDirection="column">
        <Row label="email" value={snap.email ?? "—"} />
        <Row label="tenant" value={snap.tenantSlug ?? snap.tenantId} />
        <Row label="role" value={snap.role ?? "—"} />
        <Row label="provider" value={snap.provider} />
        <Row label="engine" value={snap.baseUrl ?? "—"} />
        <Row label="server time" value={snap.serverTime} />
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color="gray">Actions:</Text>
        <Text color="gray"> n Start a new session</Text>
        <Text color="gray"> t Switch tenant (writes config; restart applies)</Text>
        <Text color="gray"> s Sign out (clears api_key; restart applies)</Text>
      </Box>
      {flash ? (
        <Box marginTop={1}>
          <Text color={flash.kind === "error" ? "red" : "green"}>
            {flash.kind === "error" ? "✗ " : "✔ "}
            {flash.msg}
          </Text>
        </Box>
      ) : null}
      {tenantPickerOpen ? (
        <Box
          marginTop={1}
          borderStyle="round"
          borderColor="cyan"
          paddingX={1}
          flexDirection="column"
        >
          <Text bold>Switch tenant</Text>
          <Text color="gray">↑/↓ navigate · Enter to switch · Esc to cancel</Text>
          {tenantList.length === 0 ? (
            <Text color="gray">loading…</Text>
          ) : (
            tenantList.map((t, i) => (
              <Box key={t.id}>
                <Text color={i === tenantIdx ? "cyan" : "white"}>
                  {i === tenantIdx ? "› " : "  "}
                </Text>
                <Text>{t.slug ?? t.id}</Text>
                {t.display_name ? <Text color="gray"> ({t.display_name})</Text> : null}
              </Box>
            ))
          )}
        </Box>
      ) : null}
    </Box>
  );
};

const Row: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <Box>
    <Box width={16}>
      <Text color="gray">{label}</Text>
    </Box>
    <Text>{value}</Text>
  </Box>
);
