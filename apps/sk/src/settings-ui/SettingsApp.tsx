import { Box, render, Text, useApp, useInput } from "ink";
import type React from "react";
import { useEffect, useState } from "react";
import type { EngineClient, SettingLeafEntry } from "../engine-client.ts";
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
  // R5-W1 review fix: the draft-store integration was previously a
  // no-op (loadDraft → saveDraft on cleanup with no modal wiring).
  // SettingsModal doesn't expose scrollTop / expanded ids on unmount
  // yet, so retention isn't implementable from here. The
  // draft-store module + its unit tests are kept as the contract;
  // wiring it through SettingsModal is left for a follow-up that
  // also threads `initialDraft` and `onClose(snapshot)`. Removing
  // the cleanup effect prevents the misleading "draft retained!"
  // appearance from creating false confidence.
  //
  // Once SettingsModal is refactored to consume `initialDraft` and
  // emit `onClose(snapshot)`, restore the load/save here keyed on
  // (profileName ?? "default", tenant ?? null).
  void profileName;

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
