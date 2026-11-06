import type { paths } from "@cli-core/engine-api/openapi";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiRequest } from "@/api/client";
import { readRecovery, restoreTenant } from "@/api/tenant-lifecycle";
import { loginHref } from "@/app/session";
import { WorkspaceRecovery } from "@/components/cockpit/patterns/workspace-recovery";

type RecoveryProviders =
  paths["/v1/identity/recovery/providers"]["get"]["responses"][200]["content"]["application/json"];

export function IdentityRecoveryPage() {
  const [confirm, setConfirm] = useState(false);
  const state = useQuery({ queryKey: ["identity-recovery"], queryFn: readRecovery, retry: false });
  const providers = useQuery({
    queryKey: ["identity-recovery-providers"],
    queryFn: () => apiRequest<RecoveryProviders>("/v1/identity/recovery/providers"),
    retry: false,
  });
  const login = useMutation({
    mutationFn: (providerId: string) =>
      apiRequest<
        paths["/v1/identity/recovery/login"]["post"]["responses"][200]["content"]["application/json"]
      >("/v1/identity/recovery/login", {
        method: "POST",
        body: JSON.stringify({ provider_id: providerId }),
      }),
    onSuccess: (result) => window.location.assign(result.authorization_url),
  });
  const restore = useMutation({
    mutationFn: restoreTenant,
    onSuccess: () => window.location.replace(loginHref({ pathname: "/cockpit", search: "" })),
  });
  return (
    <WorkspaceRecovery
      state={state}
      providers={providers}
      login={login}
      restore={restore}
      confirm={confirm}
      setConfirm={setConfirm}
    />
  );
}
