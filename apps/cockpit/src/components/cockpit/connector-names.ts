import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/api/client";
import { useSession } from "@/app/session";

export function useConnectorNames(enabled = true): ReadonlyMap<string, string> {
  return new Map(useConnectorRecords(enabled).map((item) => [item.id, item.display_name] as const));
}

export interface ConnectorRecord {
  id: string;
  slug: string;
  display_name: string;
  driver?: string | null;
  auth_type?: string | null;
  health_state?: string | null;
  needs_reauth?: boolean | null;
  auth_failed_at?: string | null;
}

export function useConnectorRecords(enabled = true): readonly ConnectorRecord[] {
  const session = useSession();
  const connectors = useQuery({
    queryKey: ["connectors", "lookup"],
    enabled: enabled && session.permissions.includes("connector:read"),
    staleTime: 300_000,
    queryFn: () => apiRequest<{ items: ConnectorRecord[] }>("/v1/connectors?limit=200"),
  });
  return connectors.data?.items ?? [];
}
