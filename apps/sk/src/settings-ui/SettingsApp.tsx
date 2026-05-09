import { Box, render, Text, useApp, useInput } from "ink";
import type React from "react";
import { useEffect, useState } from "react";
import type { EngineClient, SettingLeafEntry } from "../engine-client.ts";
import { isAdminFromPermissions } from "./lib/admin-gate.ts";
import { groupBySection, leafToFormField } from "./lib/zod-to-form-fields.ts";
import { SettingsModal } from "./SettingsModal.tsx";

export interface SettingsAppOptions {
  client: EngineClient;
  tenant?: string;
  initialTab?: string;
  // R11-W5 review fix: dropped the `profileName` prop. It was
  // documented as a no-op pending a `SettingsModal` refactor that
  // would expose `scrollTop` / `expandedKeys` / `partialFieldEdits`
  // on unmount — but a typed-but-ignored prop is a typed lie.
  // Re-add when the modal-state threading lands; the
  // draft-store module + tests at `lib/draft-store.ts` are kept
  // ready for it.
}

interface State {
  loading: boolean;
  error?: string;
  items: SettingLeafEntry[];
  pendingRestartKeys: string[];
  overrideKeys: string[];
  isAdmin: boolean;
}

// Admin-tab visibility helper lifted to lib/admin-gate.ts.
// W3 + S2 of PR #161 review round 2: previous heuristic was too
// liberal — `api_key:read`, `identity:read`, `portal_token:read` are
// member-scoped per `apps/engine/src/rbac/seed.ts`, so every tenant
// member saw the Admin tab. The shared helper now keys on permissions
// the built-in `member` role is *guaranteed not* to have.

const SettingsApp: React.FC<SettingsAppOptions & { onExit: (code: number) => void }> = ({
  client,
  tenant,
  initialTab,
  onExit,
}) => {
  const { exit } = useApp();
  const [state, setState] = useState<State>({
    loading: true,
    items: [],
    pendingRestartKeys: [],
    overrideKeys: [],
    isAdmin: false,
  });
  // R5-W1 + R11-W5: the draft-store integration was a no-op (the
  // modal didn't expose state on unmount). The `profileName` prop
  // was dropped (R11-W5). When `SettingsModal` is refactored to
  // expose `initialDraft` / `onClose(snapshot)`, re-add the prop
  // and wire the load/save here keyed on the active profile +
  // tenant. The `lib/draft-store.ts` module + its tests stay ready.

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const opts: { tenant?: string } = tenant ? { tenant } : {};
        // Fetch settings + bootstrap (for admin-permission probe) in parallel.
        // skBootstrap failure is non-fatal: we degrade to non-admin (no Admin
        // tab) and surface the settings list either way.
        const [settingsRes, bootstrap] = await Promise.all([
          client.listSettings(opts),
          client
            .skBootstrap()
            .then((b) => b)
            .catch(() => null),
        ]);
        if (cancelled) return;
        const perms = bootstrap?.permissions ?? [];
        setState({
          loading: false,
          items: settingsRes.items,
          pendingRestartKeys: settingsRes.diagnostics.pending_restart_keys,
          overrideKeys: settingsRes.diagnostics.override_keys,
          isAdmin: isAdminFromPermissions(perms),
        });
      } catch (err) {
        if (cancelled) return;
        setState({
          loading: false,
          error: err instanceof Error ? err.message : String(err),
          items: [],
          pendingRestartKeys: [],
          overrideKeys: [],
          isAdmin: false,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, tenant]);

  useInput((input, key) => {
    if (state.loading) return;
    if (state.error) {
      if (key.return || key.escape || input === "q") {
        exit();
        onExit(1);
      }
    }
  });

  if (state.loading) {
    return (
      <Box>
        <Text>Loading settings…</Text>
      </Box>
    );
  }

  if (state.error) {
    return (
      <Box flexDirection="column">
        <Text color="red">Failed to load settings: {state.error}</Text>
        <Text color="gray">Press Enter or Esc to exit.</Text>
      </Box>
    );
  }

  const fields = state.items.map(leafToFormField);
  const sections = groupBySection(fields);

  const modalProps: React.ComponentProps<typeof SettingsModal> = {
    sections,
    pendingRestartKeys: state.pendingRestartKeys,
    overrideKeys: state.overrideKeys,
    client,
    isAdmin: state.isAdmin,
    onExit: (code) => {
      exit();
      onExit(code);
    },
  };
  if (tenant !== undefined) modalProps.tenant = tenant;
  if (initialTab !== undefined) modalProps.initialTab = initialTab;
  return <SettingsModal {...modalProps} />;
};

export async function runSettingsApp(opts: SettingsAppOptions): Promise<number> {
  return new Promise<number>((resolve) => {
    const handle = render(<SettingsApp {...opts} onExit={resolve} />, { exitOnCtrlC: true });
    handle
      .waitUntilExit()
      .then(() => resolve(0))
      .catch(() => resolve(1));
  });
}
