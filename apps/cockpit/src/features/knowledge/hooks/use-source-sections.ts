import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { sourceChunksQuery } from "@/features/knowledge/api/knowledge-source-queries";
import {
  openApiEndpoints,
  rawPreview,
  sourceSections,
} from "@/features/knowledge/model/knowledge-sources-model";
import type { KnowledgeSource } from "./use-source";

export function useSourceSections(src: KnowledgeSource) {
  const chunks = useQuery(sourceChunksQuery(src));
  const sections = useMemo(() => sourceSections(chunks.data?.items ?? []), [chunks.data]);
  const contents = useMemo(() => sections.map((s) => s.content), [sections]);
  const endpoints = useMemo(() => openApiEndpoints(contents) ?? [], [contents]);
  const rawText = useMemo(() => rawPreview(contents), [contents]);
  return {
    loading: src.status === "processing" || (!chunks.data && !chunks.isError),
    sections,
    endpoints,
    rawText,
  };
}
