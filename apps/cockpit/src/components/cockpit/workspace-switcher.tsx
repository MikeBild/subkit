import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { listMemberships, switchMembership } from "@/api/memberships";
import { broadcastTenantSwitch } from "@/api/tenant-context";
import { absolute } from "@/app/links";
import { useSession } from "@/app/session";
import { WorkspaceMenu } from "./patterns/workspace-menu";

export function WorkspaceSwitcher() {
  const session = useSession();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ["identity-memberships"],
    queryFn: listMemberships,
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
  return (
    <WorkspaceMenu
      items={query.data?.items}
      tenantId={session.tenant.id}
      tenantName={session.tenant.display_name}
      changing={change.isPending}
      changingTenantId={change.variables}
      loading={query.isPending}
      loadError={query.error}
      changeError={change.error}
      open={open}
      onOpenChange={setOpen}
      onSwitch={(id) => change.mutate(id)}
    />
  );
}
