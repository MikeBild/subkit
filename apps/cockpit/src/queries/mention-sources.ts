import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { apiRequest } from "@/api/client";
import {
  categoryCandidates,
  isMentionableLabel,
  type MentionCandidate,
  rankCandidates,
} from "@/lib/mentions";
import { useDebouncedValue } from "@/lib/use-debounced-value";

const PAGE = 50;

export const MENTION_SOURCE_KEYS = {
  workflows: (q: string) => ["catalog-workflow-index", "mention-source", q] as const,
  connectors: (q: string) => ["catalog-connector-index", "mention-source", q] as const,
  sources: (q: string) => ["knowledge", "mention-source", q] as const,
  skills: (q: string) => ["skills", "mention-source", q] as const,
  files: (q: string) => ["files", "mention-source", q] as const,
};

const KNOWLEDGE_PAGE = 8;

interface WorkflowItem {
  id: string;
  slug: string;
  name: string;
}
interface ConnectorItem {
  id: string;
  slug: string;
  display_name: string;
}
interface SourceItem {
  id: string;
  slug: string;
  name: string;
}
interface SkillItem {
  id: string;
  slug: string | null;
  title: string;
}
interface FileItem {
  id: string;
  filename: string;
  size_bytes: number;
  content_type: string | null;
}

export function skillLabel(skill: SkillItem): string {
  return skill.slug ?? skill.title.trim().toLowerCase().replace(/\s+/g, "-");
}

export interface WorkflowCategory {
  category: string;
  count: number;
}

export function useWorkflowCategories(enabled: boolean): {
  categories: WorkflowCategory[];
  isLoading: boolean;
} {
  const query = useQuery({
    queryKey: ["chat", "starter-catalog"],
    enabled,
    staleTime: 30_000,
    queryFn: () => apiRequest<{ categories?: WorkflowCategory[] }>("/v1/workflows?limit=1"),
  });
  return { categories: query.data?.categories ?? [], isLoading: enabled && query.isLoading };
}

function encode(q: string): string {
  return q ? `&q=${encodeURIComponent(q)}` : "";
}

export function useMentionCandidates(
  query: string | null,
  permissions: readonly string[],
): { candidates: MentionCandidate[]; isLoading: boolean } {
  const active = query !== null;
  const q = useDebouncedValue((query ?? "").trim(), 200);
  const canWorkflows = permissions.includes("workflow:read");
  const canConnectors = permissions.includes("connector:read");
  const canSources = permissions.includes("knowledge:read");
  const canSkills = permissions.includes("skill:read");
  const canFiles = permissions.includes("file:read");
  const categories = useWorkflowCategories(active && canWorkflows);

  const workflows = useQuery({
    queryKey: MENTION_SOURCE_KEYS.workflows(q),
    enabled: active && canWorkflows,
    staleTime: 30_000,
    placeholderData: (previous) => previous,
    queryFn: () => apiRequest<{ items: WorkflowItem[] }>(`/v1/workflows?limit=${PAGE}${encode(q)}`),
  });
  const connectors = useQuery({
    queryKey: MENTION_SOURCE_KEYS.connectors(q),
    enabled: active && canConnectors,
    staleTime: 30_000,
    placeholderData: (previous) => previous,
    queryFn: () =>
      apiRequest<{ items: ConnectorItem[] }>(`/v1/connectors?limit=${PAGE}${encode(q)}`),
  });

  const sources = useQuery({
    queryKey: MENTION_SOURCE_KEYS.sources(q),
    enabled: active && canSources,
    staleTime: 30_000,
    placeholderData: (previous) => previous,
    queryFn: () =>
      apiRequest<{ items: SourceItem[] }>(
        `/v1/knowledge-sources?limit=${KNOWLEDGE_PAGE}${encode(q)}`,
      ),
  });
  const skills = useQuery({
    queryKey: MENTION_SOURCE_KEYS.skills(q),
    enabled: active && canSkills,
    staleTime: 30_000,
    placeholderData: (previous) => previous,
    queryFn: () =>
      apiRequest<{ items: SkillItem[] }>(
        `/v1/skills?status=active&limit=${KNOWLEDGE_PAGE}${encode(q)}`,
      ),
  });
  const files = useQuery({
    queryKey: MENTION_SOURCE_KEYS.files(q),
    enabled: active && canFiles,
    staleTime: 30_000,
    placeholderData: (previous) => previous,
    queryFn: () =>
      apiRequest<{ items: FileItem[] }>(`/v1/files?limit=${KNOWLEDGE_PAGE}${encode(q)}`),
  });

  const candidates = useMemo(() => {
    const all: MentionCandidate[] = [
      ...(workflows.data?.items ?? [])
        .filter((w) => isMentionableLabel(w.slug))
        .map((w) => ({ type: "workflow" as const, id: w.id, label: w.slug, title: w.name })),
      ...(connectors.data?.items ?? [])
        .filter((c) => isMentionableLabel(c.slug))
        .map((c) => ({
          type: "connector" as const,
          id: c.id,
          label: c.slug,
          title: c.display_name,
        })),
      ...(sources.data?.items ?? [])
        .filter((source) => isMentionableLabel(source.slug))
        .map((source) => ({
          type: "knowledge_source" as const,
          id: source.id,
          label: source.slug,
          title: source.name,
        })),
      ...(skills.data?.items ?? [])
        .filter((skill) => isMentionableLabel(skillLabel(skill)))
        .map((skill) => ({
          type: "skill" as const,
          id: skill.id,
          label: skillLabel(skill),
          title: skill.title,
        })),
      ...(files.data?.items ?? []).map((file) => ({
        type: "file" as const,
        id: file.id,
        label: file.filename,
        title: file.filename,
        size: file.size_bytes,
        contentType: file.content_type,
      })),
    ];
    return [
      ...categoryCandidates(categories.categories, query ?? ""),
      ...rankCandidates(all, query ?? ""),
    ];
  }, [
    workflows.data,
    connectors.data,
    sources.data,
    skills.data,
    files.data,
    categories.categories,
    query,
  ]);

  return {
    candidates,
    isLoading:
      active &&
      (workflows.isLoading ||
        connectors.isLoading ||
        sources.isLoading ||
        skills.isLoading ||
        files.isLoading ||
        categories.isLoading),
  };
}
