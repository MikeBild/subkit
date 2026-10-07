import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { apiRequest } from "@/api/client";
import { useLiveQueryOptions } from "@/app/live-events";
import { useSession } from "@/app/session";
import { canReadDirectory } from "@/pages/audit-model";

type People = { items?: Array<{ id: string; email?: string; name?: string }> };
type Accounts = { items?: Array<{ id: string; name?: string }> };

export function actorDirectory(people: People | undefined, accounts: Accounts | undefined) {
  const byId = new Map<string, string>();
  for (const item of people?.items ?? []) {
    const label = item.name?.trim() || item.email?.trim();
    if (label) byId.set(item.id, label);
  }
  for (const item of accounts?.items ?? []) {
    const label = item.name?.trim();
    if (label) byId.set(item.id, label);
  }
  return byId;
}

export function useActorDirectory(enabled: boolean): ReadonlyMap<string, string> {
  const session = useSession();
  const live = useLiveQueryOptions();
  const readable = enabled && canReadDirectory(session);
  const people = useQuery({
    queryKey: ["audit-directory", "people"],
    enabled: readable,
    queryFn: () => apiRequest<People>("/v1/identity/users?limit=200"),
    ...live,
  });
  const accounts = useQuery({
    queryKey: ["audit-directory", "system-accounts"],
    enabled: readable,
    queryFn: () => apiRequest<Accounts>("/v1/identity/system-accounts"),
    ...live,
  });
  return useMemo(() => actorDirectory(people.data, accounts.data), [people.data, accounts.data]);
}
