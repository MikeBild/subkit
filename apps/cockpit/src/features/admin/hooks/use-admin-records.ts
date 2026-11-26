import { useQuery } from "@tanstack/react-query";
import { connectorRecordsQuery, permissionsQuery, workflowRecordsQuery } from "../api/queries";

export function useWorkflowRecords(enabled: boolean) {
  return useQuery({ ...workflowRecordsQuery(), enabled });
}

export function useConnectorRecords(enabled: boolean) {
  return useQuery({ ...connectorRecordsQuery(), enabled });
}

export function usePermissionCatalog(enabled: boolean) {
  return useQuery({ ...permissionsQuery(), enabled });
}
