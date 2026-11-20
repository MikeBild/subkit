import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useState } from "react";
import {
  getCurrentCockpitInstallation,
  revokeCockpitInstallation,
} from "@/api/cockpit-installations";
import { listMemberships, switchMembership } from "@/api/memberships";
import { broadcastTenantSwitch } from "@/api/tenant-context";
import { absolute } from "@/app/links";
import { useSession } from "@/app/session";
import { reportFailure } from "@/lib/action-failure";
import { useI18n } from "@/lib/i18n-context";
import { BrandingWordmark } from "./branding";
import { InstallationDialog } from "./installation-dialogs";
import { ConfirmDialog } from "./patterns";
import { WorkspaceMenu } from "./patterns/workspace-menu";

export function WorkspaceSwitcher({ attention }: { attention?: ReactNode }) {
  const session = useSession();
  const { t } = useI18n();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const query = useQuery({
    queryKey: ["identity-memberships"],
    queryFn: listMemberships,
    retry: false,
    enabled: session.identity_memberships,
  });
  const installation = useQuery({
    queryKey: ["cockpit-installation"],
    queryFn: getCurrentCockpitInstallation,
    retry: false,
  });
  const change = useMutation({
    mutationFn: switchMembership,
    onSuccess: async (_response, nextTenantId) => {
      broadcastTenantSwitch(nextTenantId);
      await client.cancelQueries();
      client.clear();
      window.location.replace(absolute("/"));
    },
    onError: () => setOpen(true),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => revokeCockpitInstallation(id),
    onError: (failure) => reportFailure(t("common.actionFailed"), failure),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["cockpit-installation"] });
      setRevoking(false);
    },
  });
  const currentInstallation = installation.data?.installation ?? null;
  return (
    <>
      <WorkspaceMenu
        items={query.data?.items}
        tenantId={session.tenant.id}
        tenantName={session.tenant.display_name}
        wordmark={<BrandingWordmark />}
        attention={attention}
        changing={change.isPending}
        changingTenantId={change.variables}
        loading={session.identity_memberships && query.isPending}
        loadError={query.error}
        changeError={change.error}
        open={open}
        onOpenChange={setOpen}
        onSwitch={(id) => change.mutate(id)}
        currentOnly={!session.identity_memberships}
        onInstall={() => {
          setOpen(false);
          setInstalling(true);
        }}
        onRevoke={
          currentInstallation
            ? () => {
                setOpen(false);
                setRevoking(true);
              }
            : undefined
        }
      />
      {currentInstallation ? (
        <ConfirmDialog
          open={revoking}
          onOpenChange={setRevoking}
          object={session.tenant.display_name}
          verb={t("installation.revoke")}
          consequence={t("installation.revokeConsequence")}
          destructive
          pending={revoke.isPending}
          onConfirm={() => revoke.mutate(currentInstallation.id)}
          testId="workspace-revoke-installation-dialog"
        />
      ) : null}
      <InstallationDialog
        open={installing}
        onOpenChange={setInstalling}
        tenantName={session.tenant.display_name}
        installation={currentInstallation}
      />
    </>
  );
}
