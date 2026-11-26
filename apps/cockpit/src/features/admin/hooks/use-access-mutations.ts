import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiCall } from "@/api/call";
import { adminKeys } from "../api/keys";

interface MutationCallbacks {
  onSuccess?(): void;
  onRefreshed?(): void;
  onError?(error: unknown): void;
}

interface GrantSubject {
  subject_type: "user" | "group";
  subject_id: string;
}

export function useRolePermissionToggle(roleId: string | undefined, callbacks: MutationCallbacks) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ permission, enabled }: { permission: string; enabled: boolean }) =>
      enabled
        ? apiCall("post", "/v1/rbac/roles/{id}/permissions", {
            path: { id: roleId ?? "" },
            body: { permission },
          })
        : apiCall("delete", "/v1/rbac/roles/{id}/permissions/{permission}", {
            path: { id: roleId ?? "", permission },
          }),
    onSuccess: () => client.invalidateQueries({ queryKey: adminKeys.role(roleId) }),
    onError: (error) => callbacks.onError?.(error),
  });
}

export function useCreateAccessGroup(callbacks: {
  onSuccess(): void;
  onRefreshed(kind: "role" | "group"): void;
  onError(error: unknown): void;
}) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({
      kind,
      name,
      description,
    }: {
      kind: "role" | "group";
      name: string;
      description: string;
    }) => {
      const body = {
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
      };
      if (kind === "role") return await apiCall("post", "/v1/rbac/roles", { body });
      return await apiCall("post", "/v1/rbac/groups", { body });
    },
    onSuccess: async (_created, { kind }) => {
      callbacks.onSuccess();
      await client.invalidateQueries({
        queryKey: kind === "role" ? adminKeys.roles() : adminKeys.groups(),
      });
      callbacks.onRefreshed(kind);
    },
    onError: (error) => callbacks.onError(error),
  });
}

export function useAddGroupMember(groupId: string | undefined, callbacks: MutationCallbacks) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      apiCall("post", "/v1/rbac/groups/{id}/members/{user_id}", {
        path: { id: groupId ?? "", user_id: userId },
      }),
    onSuccess: async () => {
      callbacks.onSuccess?.();
      await client.invalidateQueries({ queryKey: adminKeys.all });
      callbacks.onRefreshed?.();
    },
    onError: (error) => callbacks.onError?.(error),
  });
}

export function useAssignGroupRole(groupId: string | undefined, callbacks: MutationCallbacks) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (roleId: string) =>
      apiCall("post", "/v1/rbac/groups/{id}/roles/{role_id}", {
        path: { id: groupId ?? "", role_id: roleId },
      }),
    onSuccess: async () => {
      callbacks.onSuccess?.();
      await client.invalidateQueries({ queryKey: adminKeys.all });
      callbacks.onRefreshed?.();
    },
    onError: (error) => callbacks.onError?.(error),
  });
}

export function useRevokeGrant(callbacks: MutationCallbacks) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiCall("delete", "/v1/rbac/grants/{id}", { path: { id } }),
    onSuccess: async () => {
      callbacks.onSuccess?.();
      await client.invalidateQueries({ queryKey: adminKeys.grants() });
      callbacks.onRefreshed?.();
    },
    onError: (error) => callbacks.onError?.(error),
  });
}

export function useCreateWorkflowGrant(callbacks: MutationCallbacks) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      subject,
      workflowId,
      permission,
    }: {
      subject: GrantSubject | null;
      workflowId: string;
      permission: string;
    }) => {
      if (!subject) throw new Error("grant subject missing");
      return apiCall("post", "/v1/rbac/grants", {
        body: { ...subject, resource_type: "workflow", resource_id: workflowId, permission },
      });
    },
    onSuccess: async () => {
      callbacks.onSuccess?.();
      await client.invalidateQueries({ queryKey: adminKeys.grants() });
      callbacks.onRefreshed?.();
    },
    onError: (error) => callbacks.onError?.(error),
  });
}
