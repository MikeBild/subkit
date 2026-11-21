import { useQuery } from "@tanstack/react-query";
import { apiCall } from "@/api/call";
import {
  operatingFiguresQuery,
  type PromptCacheFlow,
  promptCacheFlows,
  type Read,
  type WindowBounds,
} from "@/features/usage/model/operations-figures";

export function useOperatingFiguresQuery(bounds: WindowBounds, enabled: boolean) {
  return useQuery({
    queryKey: ["operations-figures", bounds],
    enabled,
    queryFn: () =>
      apiCall("get", "/v1/stats/operating-figures", { query: operatingFiguresQuery(bounds) }),
  });
}

export function usePromptCacheFlows(bounds: WindowBounds, enabled: boolean) {
  const query = useOperatingFiguresQuery(bounds, enabled);
  const read: Read<PromptCacheFlow[] | null> = query.isError
    ? { state: "failed" }
    : { state: "answered", value: promptCacheFlows(query.data) };
  return { read, pending: query.isPending, retry: () => void query.refetch() };
}
