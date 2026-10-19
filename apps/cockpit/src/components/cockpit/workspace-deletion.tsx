import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { broadcastTenantSwitch } from "@/api/tenant-context";
import { readOwnedTenant, requestTenantDeletion } from "@/api/tenant-lifecycle";
import { absolute } from "@/app/links";
import { useSession } from "@/app/session";
import { WorkspaceDeletionForm } from "./patterns/workspace-deletion-form";

export function WorkspaceDeletion() {
  const session = useSession();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const query = useQuery({ queryKey: ["owned-tenant"], queryFn: readOwnedTenant, retry: false });
  const deletion = useMutation({
    mutationFn: requestTenantDeletion,
    onSuccess: async () => {
      broadcastTenantSwitch("tenant-unavailable");
      await client.cancelQueries();
      client.clear();
      window.location.replace(absolute("/recovery"));
    },
    onError: () => {
      setOpen(false);
      void query.refetch();
    },
  });
  const tenant = query.data?.tenant;
  if (!tenant || tenant.id !== session.tenant.id || tenant.status !== "active") return null;
  return (
    <WorkspaceDeletionForm
      tenant={tenant}
      deletion={deletion}
      open={open}
      setOpen={setOpen}
      confirmation={confirmation}
      setConfirmation={setConfirmation}
    />
  );
}
