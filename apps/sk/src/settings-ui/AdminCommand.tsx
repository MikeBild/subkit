// `/admin` slash command — single-pane modal wrapping the existing
// AdminTab. Lifted out of /settings as part of the 5-tab refactor.
//
// Probes the user's permissions on mount via skBootstrap so a
// non-admin sees an in-pane "no permission" message instead of an
// empty tab. The server still enforces RBAC on every mutation; the
// gate here is purely UX.

import { Box, Text } from "ink";
import type React from "react";
import { useEffect, useState } from "react";

import type { EngineClient } from "../engine-client.ts";
import { isAdminFromPermissions } from "./lib/admin-gate.ts";
import { SinglePane } from "./SinglePane.tsx";
import { AdminTab } from "./tabs/AdminTab.tsx";

interface Props {
  client: EngineClient;
  tenant?: string | null;
  onDismiss: () => void;
}

type GateState =
  { kind: "loading" } | { kind: "ready"; isAdmin: boolean } | { kind: "error"; message: string };

export const AdminCommand: React.FC<Props> = ({ client, tenant, onDismiss }) => {
  const [state, setState] = useState<GateState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const b = await client.skBootstrap();
        if (cancelled) return;
        setState({
          kind: "ready",
          isAdmin: isAdminFromPermissions(b.permissions ?? []),
        });
      } catch (err) {
        if (cancelled) return;
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  return (
    <SinglePane title="sk admin" tenant={tenant ?? null} onDismiss={onDismiss}>
      {({ setInnerEscape }) => {
        if (state.kind === "loading") return <Text color="gray">loading…</Text>;
        if (state.kind === "error") return <Text color="red">failed: {state.message}</Text>;
        if (!state.isAdmin) {
          return (
            <Box flexDirection="column">
              <Text color="yellow">no admin permissions on this principal</Text>
              <Text color="gray">
                contact a tenant admin or rotate to an api key with rbac:read.
              </Text>
            </Box>
          );
        }
        // AdminTab aggregates its sub-tabs' inner-Esc state and forwards
        // it here, so the outer SinglePane stays open while an
        // AdminCreateForm / consent prompt is up.
        return <AdminTab client={client} onInnerEscape={setInnerEscape} />;
      }}
    </SinglePane>
  );
};
