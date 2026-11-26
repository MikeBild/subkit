import { queryOptions } from "@tanstack/react-query";
import { apiCall } from "@/api/call";
import { adminKeys } from "./keys";

const RECORD_LIMIT = 200;

export function peopleQuery() {
  return queryOptions({
    queryKey: adminKeys.people(),
    queryFn: () => apiCall("get", "/v1/identity/users", { query: { limit: RECORD_LIMIT } }),
  });
}

export function rolesQuery() {
  return queryOptions({
    queryKey: adminKeys.roles(),
    queryFn: () => apiCall("get", "/v1/rbac/roles", {}),
  });
}

export function roleDetailQuery(id: string | undefined) {
  return queryOptions({
    queryKey: adminKeys.role(id),
    queryFn: () => apiCall("get", "/v1/rbac/roles/{id}", { path: { id: id ?? "" } }),
    enabled: Boolean(id),
  });
}

export function groupsQuery() {
  return queryOptions({
    queryKey: adminKeys.groups(),
    queryFn: () => apiCall("get", "/v1/rbac/groups", {}),
  });
}

export function grantsQuery() {
  return queryOptions({
    queryKey: adminKeys.grants(),
    queryFn: () => apiCall("get", "/v1/rbac/grants", {}),
  });
}

export function permissionsQuery() {
  return queryOptions({
    queryKey: adminKeys.permissions(),
    queryFn: () => apiCall("get", "/v1/rbac/permissions", {}),
  });
}

export function workflowRecordsQuery() {
  return queryOptions({
    queryKey: adminKeys.workflows(),
    queryFn: () => apiCall("get", "/v1/workflows", { query: { limit: RECORD_LIMIT } }),
  });
}

export function connectorRecordsQuery() {
  return queryOptions({
    queryKey: adminKeys.connectors(),
    queryFn: () => apiCall("get", "/v1/connectors", { query: { limit: RECORD_LIMIT } }),
  });
}
