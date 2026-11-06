import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiCall } from "@/api/call";
import { readRecovery, restoreTenant } from "@/api/tenant-lifecycle";
import { loginHref } from "@/app/session";
import { WorkspaceRecovery } from "@/components/cockpit/patterns/workspace-recovery";

export function IdentityRecoveryPage() {
  const [confirm, setConfirm] = useState(false);
  const state = useQuery({ queryKey: ["identity-recovery"], queryFn: readRecovery, retry: false });
  const providers = useQuery({
    queryKey: ["identity-recovery-providers"],
    queryFn: () => apiCall("get", "/v1/identity/recovery/providers", {}),
    retry: false,
  });
  const login = useMutation({
    mutationFn: (providerId: string) =>
      apiCall("post", "/v1/identity/recovery/login", { body: { provider_id: providerId } }),
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
