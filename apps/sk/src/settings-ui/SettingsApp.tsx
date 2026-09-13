import { Box, render, Text, useApp, useInput } from "ink";
import type React from "react";
import { useEffect, useState } from "react";

import type { EngineClient, SettingLeafEntry } from "../engine-client.ts";
import { leafToFormField } from "./lib/zod-to-form-fields.ts";
import { SettingsModal } from "./SettingsModal.tsx";

export interface SettingsAppOptions {
  client: EngineClient;
  tenant?: string;
  initialTab?: string;
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
  onExit,
}) => {
  const { exit } = useApp();
  const [state, setState] = useState<State>({
    loading: true,
    items: [],
    pendingRestartKeys: [],
    overrideKeys: [],
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const opts: { tenant?: string } = tenant ? { tenant } : {};
        const settingsRes = await client.listSettings(opts);
        if (cancelled) return;
        setState({
          loading: false,
          items: settingsRes.items,
          pendingRestartKeys: settingsRes.diagnostics.pending_restart_keys,
          overrideKeys: settingsRes.diagnostics.override_keys,
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

  const modalProps: React.ComponentProps<typeof SettingsModal> = {
    fields,
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
