import { Box, Text } from "ink";
import type React from "react";
import { useEffect, useState } from "react";
import type { EngineClient, SettingLeafEntry } from "../engine-client.ts";
import { leafToFormField } from "./lib/zod-to-form-fields.ts";
import { SettingsModal } from "./SettingsModal.tsx";

interface SettingsPaneProps {
  client: EngineClient;
  tenant?: string;
  initialTab?: string;
  sessionId?: string | null;
  sessionTitle?: string | null;
  permissionMode?: "ask" | "auto" | "plan" | "yolo";
  sessionTokens?: number | null;
  weekTokens?: number | null;
  onDismiss: () => void;
}

interface State {
  loading: boolean;
  error?: string;
  items: SettingLeafEntry[];
  pendingRestartKeys: string[];
  overrideKeys: string[];
  fetchedSessionTitle?: string | null;
}

export const SettingsPane: React.FC<SettingsPaneProps> = ({
  client,
  tenant,
  initialTab,
  sessionId,
  sessionTitle,
  permissionMode,
  sessionTokens,
  weekTokens,
  onDismiss,
}) => {
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
        const [settingsRes, convDetail] = await Promise.all([
          client.listSettings(opts),
          sessionId
            ? client
                .getConversation(sessionId)
                .then((d) => d)
                .catch(() => null)
            : Promise.resolve(null),
        ]);
        if (cancelled) return;
        const conv = convDetail as { conversation?: { title?: string | null } } | null;
        const fetchedTitle = conv?.conversation?.title ?? null;
        setState({
          loading: false,
          items: settingsRes.items,
          pendingRestartKeys: settingsRes.diagnostics.pending_restart_keys,
          overrideKeys: settingsRes.diagnostics.override_keys,
          fetchedSessionTitle: fetchedTitle,
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
  }, [client, tenant, sessionId]);

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
        <Text color="gray">Press Esc to dismiss.</Text>
      </Box>
    );
  }

  const fields = state.items.map(leafToFormField);

  const props: React.ComponentProps<typeof SettingsModal> = {
    fields,
    pendingRestartKeys: state.pendingRestartKeys,
    overrideKeys: state.overrideKeys,
    client,
    onExit: () => onDismiss(),
  };
  if (tenant !== undefined) props.tenant = tenant;
  if (initialTab !== undefined) props.initialTab = initialTab;
  if (sessionId !== undefined) props.sessionId = sessionId;
  const resolvedTitle = state.fetchedSessionTitle ?? sessionTitle;
  if (resolvedTitle !== undefined) props.sessionTitle = resolvedTitle;
  if (permissionMode !== undefined) props.permissionMode = permissionMode;
  if (sessionTokens !== undefined) props.sessionTokens = sessionTokens;
  if (weekTokens !== undefined) props.weekTokens = weekTokens;
  return <SettingsModal {...props} />;
};
