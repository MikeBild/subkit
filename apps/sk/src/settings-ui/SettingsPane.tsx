// Embeddable variant of SettingsApp — runs inside an existing Ink
// instance instead of mounting its own. Used by the REPL's /settings
// slash so the modal renders alongside the transcript and inherits
// REPL state (sessionId, permissionMode, token counters).

import { Box, Text } from "ink";
import type React from "react";
import { useEffect, useState } from "react";
import type { EngineClient, SettingLeafEntry } from "../engine-client.ts";
// W3 + S2 of PR #161 review round 2: shared `isAdminFromPermissions`
// helper, lifted from this file + SettingsApp.tsx.
import { isAdminFromPermissions } from "./lib/admin-gate.ts";
import { groupBySection, leafToFormField } from "./lib/zod-to-form-fields.ts";
import { SettingsModal } from "./SettingsModal.tsx";

export interface SettingsPaneProps {
  client: EngineClient;
  tenant?: string;
  initialTab?: string;
  sessionId?: string | null;
  sessionTitle?: string | null;
  permissionMode?: "ask" | "auto" | "plan" | "yolo";
  sessionTokens?: number | null;
  weekTokens?: number | null;
  onDismiss: () => void;
  onProfileAction?: (action: import("./tabs/ProfileTab.tsx").ProfileAction) => void;
}

interface State {
  loading: boolean;
  error?: string;
  items: SettingLeafEntry[];
  pendingRestartKeys: string[];
  overrideKeys: string[];
  isAdmin: boolean;
  /** H2 closure of #159 — fetched lazily once sessionId is known. */
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
  onProfileAction,
}) => {
  const [state, setState] = useState<State>({
    loading: true,
    items: [],
    pendingRestartKeys: [],
    overrideKeys: [],
    isAdmin: false,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const opts: { tenant?: string } = tenant ? { tenant } : {};
        // H2 closure of #159 — fetch the conversation alongside settings
        // so the Status tab's "session name" row populates from the
        // engine when the host doesn't supply `sessionTitle`.
        const [settingsRes, bootstrap, convDetail] = await Promise.all([
          client.listSettings(opts),
          client
            .skBootstrap()
            .then((b) => b)
            .catch(() => null),
          sessionId
            ? client
                .getConversation(sessionId)
                .then((d) => d)
                .catch(() => null)
            : Promise.resolve(null),
        ]);
        if (cancelled) return;
        const perms = bootstrap?.permissions ?? [];
        const conv = convDetail as { conversation?: { title?: string | null } } | null;
        const fetchedTitle = conv?.conversation?.title ?? null;
        setState({
          loading: false,
          items: settingsRes.items,
          pendingRestartKeys: settingsRes.diagnostics.pending_restart_keys,
          overrideKeys: settingsRes.diagnostics.override_keys,
          isAdmin: isAdminFromPermissions(perms),
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
          isAdmin: false,
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
  const sections = groupBySection(fields);

  const props: React.ComponentProps<typeof SettingsModal> = {
    sections,
    pendingRestartKeys: state.pendingRestartKeys,
    overrideKeys: state.overrideKeys,
    client,
    isAdmin: state.isAdmin,
    onExit: () => onDismiss(),
  };
  if (tenant !== undefined) props.tenant = tenant;
  if (initialTab !== undefined) props.initialTab = initialTab;
  if (sessionId !== undefined) props.sessionId = sessionId;
  // The engine-fetched title beats the host-supplied placeholder when
  // both exist; the host's value is only used during the brief
  // pre-fetch interval.
  const resolvedTitle = state.fetchedSessionTitle ?? sessionTitle;
  if (resolvedTitle !== undefined) props.sessionTitle = resolvedTitle;
  if (permissionMode !== undefined) props.permissionMode = permissionMode;
  if (sessionTokens !== undefined) props.sessionTokens = sessionTokens;
  if (weekTokens !== undefined) props.weekTokens = weekTokens;
  if (onProfileAction !== undefined) props.onProfileAction = onProfileAction;
  return <SettingsModal {...props} />;
};
