// `/profile` slash command — single-pane modal wrapping the existing
// ProfileTab. Lifted out of /settings as part of the 5-tab refactor.
// The host (ink-app.tsx) forwards `onAction` callbacks directly,
// since Profile is no longer routed through the settings shell.
//
// Two-step Esc: ProfileTab fires `onInnerEscape(true)` while the
// tenant picker is open. The SinglePane render-prop wires that back
// into the shell's `innerActive` state so the first Esc closes the
// picker (handled inside ProfileTab) and the second Esc dismisses
// the pane — matching the SettingsModal Config tab behavior.

import type React from "react";

import type { EngineClient } from "../engine-client.ts";
import { SinglePane } from "./SinglePane.tsx";
import { type ProfileAction, ProfileTab } from "./tabs/ProfileTab.tsx";

interface Props {
  client: EngineClient;
  tenant?: string | null;
  onDismiss: () => void;
  onAction?: (action: ProfileAction) => void;
}

export const ProfileCommand: React.FC<Props> = ({ client, tenant, onDismiss, onAction }) => {
  return (
    <SinglePane title="sk profile" tenant={tenant ?? null} onDismiss={onDismiss}>
      {({ setInnerEscape }) => {
        const tabProps: React.ComponentProps<typeof ProfileTab> = {
          client,
          onInnerEscape: setInnerEscape,
        };
        if (onAction) tabProps.onAction = onAction;
        return <ProfileTab {...tabProps} />;
      }}
    </SinglePane>
  );
};
