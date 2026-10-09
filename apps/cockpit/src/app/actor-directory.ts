import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { apiRequest } from "@/api/client";
import { useLiveQueryOptions } from "@/app/live-events";
import { useSession } from "@/app/session";
import { canReadDirectory } from "@/pages/audit-model";
import {
  type Accounts,
  type ActorDirectory,
  actorDirectory,
  type People,
} from "./actor-directory-model";

export function useActorDirectory(enabled: boolean): ActorDirectory {
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
