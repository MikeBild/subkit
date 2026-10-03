import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/api/client";
import { useSession } from "@/app/session";

/**
 * The connectors by id, for every place that has an id and owes the reader a
 * name: a step's row, an approval's effects, the approval dialog. One read
 * under one key, so the three cannot name the same connector differently —
 * and none of them falls back to a fragment of the id.
 *
 * Empty for a reader without `connector:read` and while the read is out; the
 * caller then says "configured connector", never the identifier.
 */
export function useConnectorNames(enabled = true): ReadonlyMap<string, string> {
  return new Map(useConnectorRecords(enabled).map((item) => [item.id, item.display_name] as const));
}

/** What the lookup knows of each connector: its name and where its sign-in stands. */
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

/** The same one read as `useConnectorNames`, whole. */
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
