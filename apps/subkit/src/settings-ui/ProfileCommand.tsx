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
    <SinglePane title="subkit profile" tenant={tenant ?? null} onDismiss={onDismiss}>
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
