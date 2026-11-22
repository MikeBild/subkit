import { queryOptions } from "@tanstack/react-query";
import { apiCall } from "@/api/call";
import { loadKnowledgeChunks } from "@/api/knowledge";
import { versionText } from "@/features/knowledge/model/knowledge-versions-model";
import { KEYS } from "../queries";

const PROCESSING_POLL_MS = 2000;
const HISTORY_LIMIT = 50;

export function sourceQuery(id: string) {
  return queryOptions({
    queryKey: KEYS.source(id),
    queryFn: () => apiCall("get", "/v1/knowledge-sources/{id}", { path: { id } }),
    refetchInterval: (q) => (q.state.data?.status === "processing" ? PROCESSING_POLL_MS : false),
  });
}

export function sourceChunksQuery(src: { id: string; version: string; status: string }) {
  return queryOptions({
    queryKey: [...KEYS.source(src.id), "chunks", src.version],
    queryFn: () => loadKnowledgeChunks(src.id),
    enabled: src.status !== "processing",
  });
}

export function sourceHistoryQuery(id: string) {
  return queryOptions({
    queryKey: [...KEYS.source(id), "history"],
    queryFn: () =>
      apiCall("get", "/v1/knowledge-sources/{id}/history", {
        path: { id },
        query: { limit: HISTORY_LIMIT },
      }),
  });
}

export function sourceContentQuery(id: string, enabled: boolean) {
  return queryOptions({
    queryKey: [...KEYS.source(id), "content"],
    queryFn: () => apiCall("get", "/v1/knowledge-sources/{id}/content", { path: { id } }),
    enabled,
  });
}

export async function loadSourceVersionText(id: string, version: number): Promise<string> {
  const detail = await apiCall("get", "/v1/knowledge-sources/{id}/history/{version}", {
    path: { id, version },
  });
  return versionText(detail.documents);
}
