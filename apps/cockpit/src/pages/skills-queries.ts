import { useQuery } from "@tanstack/react-query";
import { apiCall } from "@/api/call";
import { useLiveQueryOptions } from "@/app/live-events";

export function useSkill(id: string, enabled: boolean) {
  const live = useLiveQueryOptions();
  return useQuery({
    queryKey: ["skill", id],
    queryFn: () => apiCall("get", "/v1/skills/{id}", { path: { id } }),
    enabled: enabled && Boolean(id) && id !== "new",
    ...live,
  });
}

export function useSkillHistory(
  id: string,
  enabled: boolean,
  live?: ReturnType<typeof useLiveQueryOptions>,
) {
  return useQuery({
    queryKey: ["skill", id, "history"],
    queryFn: () => apiCall("get", "/v1/skills/{id}/history", { path: { id } }),
    enabled,
    ...live,
  });
}
