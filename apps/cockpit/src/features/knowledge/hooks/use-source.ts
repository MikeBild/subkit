import { useQuery } from "@tanstack/react-query";
import type { ApiResponse } from "@/api/call";
import {
  sourceContentQuery,
  sourceHistoryQuery,
  sourceQuery,
} from "@/features/knowledge/api/knowledge-source-queries";

export type KnowledgeSource = ApiResponse<"/v1/knowledge-sources/{id}", "get">;

export function useSource(id: string) {
  return useQuery(sourceQuery(id));
}

export function useSourceHistory(id: string) {
  return useQuery(sourceHistoryQuery(id));
}

export function useSourceContent(id: string, enabled: boolean) {
  return useQuery(sourceContentQuery(id, enabled));
}
