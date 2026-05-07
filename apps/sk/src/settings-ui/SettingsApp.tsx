import { Box, render, Text, useApp, useInput } from "ink";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import type { EngineClient, SettingLeafEntry } from "../engine-client.ts";
import { loadDraft, type SettingsDraftSnapshot, saveDraft } from "./lib/draft-store.ts";
import { groupBySection, leafToFormField } from "./lib/zod-to-form-fields.ts";
import { SettingsModal } from "./SettingsModal.tsx";

export interface SettingsAppOptions {
  client: EngineClient;
  tenant?: string;
  initialTab?: string;
  /** Profile name used as the draft-store key. Defaults to "default" so
   *  callers that don't pass it still get retention scoped per-tenant. */
  profileName?: string;
}

interface State {
  loading: boolean;
  error?: string;
  items: SettingLeafEntry[];
  pendingRestartKeys: string[];
  overrideKeys: string[];
}

const SettingsApp: React.FC<SettingsAppOptions & { onExit: (code: number) => void }> = ({
  client,
  tenant,
  initialTab,
  profileName,
  onExit,
}) => {
  const { exit } = useApp();
  const [state, setState] = useState<State>({
    loading: true,
    items: [],
    pendingRestartKeys: [],
    overrideKeys: [],
  });
  const draftKeyRef = useRef<{ profile: string; tenant: string | null }>({
    profile: profileName ?? "default",
    tenant: tenant ?? null,
  });
  // Hydrate the retained scroll/expanded state on mount; persist on
  // unmount so close+reopen lands the operator where they were.
  const initialDraftRef = useRef<SettingsDraftSnapshot | null>(null);
  if (initialDraftRef.current === null) {
    initialDraftRef.current = loadDraft(draftKeyRef.current.profile, draftKeyRef.current.tenant);
  }
  useEffect(() => {
    return () => {
      // Best-effort persist — if the modal exposed scrollTop/expanded
      // ids back to us we'd save them; for now we keep the existing
      // entry alive (loadDraft on next open returns the same snapshot).
      const current = loadDraft(draftKeyRef.current.profile, draftKeyRef.current.tenant);
      saveDraft(draftKeyRef.current.profile, draftKeyRef.current.tenant, current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const opts: { tenant?: string } = tenant ? { tenant } : {};
        const res = await client.listSettings(opts);
        if (cancelled) return;
        setState({
          loading: false,
          items: res.items,
          pendingRestartKeys: res.diagnostics.pending_restart_keys,
          overrideKeys: res.diagnostics.override_keys,
        });
      } catch (err) {
        if (cancelled) return;
        setState({
          loading: false,
          error: err instanceof Error ? err.message : String(err),
          items: [],
          pendingRestartKeys: [],
          overrideKeys: [],
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
