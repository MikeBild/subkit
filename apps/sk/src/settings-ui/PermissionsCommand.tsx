import type React from "react";
import type { EngineClient } from "../engine-client.ts";
import { SinglePane } from "./SinglePane.tsx";
import { PermissionsTab, type ReplPermissionMode } from "./tabs/PermissionsTab.tsx";

interface Props {
  client: EngineClient;
  tenant?: string | null;
  onDismiss: () => void;
  initial?: ReplPermissionMode;
  onSelect?: (mode: ReplPermissionMode) => void;
}

export const PermissionsCommand: React.FC<Props> = ({
  client,
  tenant,
  onDismiss,
  initial,
  onSelect,
}) => {
  const tabProps: React.ComponentProps<typeof PermissionsTab> = { client };
  if (tenant) tabProps.tenant = tenant;
  if (initial !== undefined) tabProps.initial = initial;
  if (onSelect) tabProps.onSelect = onSelect;
  return (
    <SinglePane title="sk permissions" tenant={tenant ?? null} onDismiss={onDismiss}>
      {() => <PermissionsTab {...tabProps} />}
    </SinglePane>
  );
};
