import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { apiRequest } from "@/api/client";
import type { ChatReferenceSeed } from "@/app/links";
import {
  type ConversationReference,
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
  intake: (q: string) => ["intake", "mention-source", q] as const,
  intakeSeed: (ids: readonly string[]) => ["intake", "mention-seed", ids] as const,
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
interface IntakeMentionItem {
  id: string;
  title: string;
  source_url: string | null;
  category: string;
  state: string;
  version: number;
}

export function skillLabel(skill: SkillItem): string {
  return skill.slug ?? skill.title.trim().toLowerCase().replace(/\s+/g, "-");
}

export function intakeMentionLabel(title: string): string {
  return mentionLabel(title, "Eintrag");
}

function mentionLabel(title: string, fallback: string): string {
  const label = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}_./-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200);
  return isMentionableLabel(label) ? label : fallback;
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
  const canIntake = permissions.includes("intake:read");
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
  const intake = useQuery({
    queryKey: MENTION_SOURCE_KEYS.intake(q),
    enabled: active && canIntake,
    staleTime: 30_000,
    placeholderData: (previous) => previous,
    queryFn: () =>
      apiRequest<{ items: IntakeMentionItem[] }>(
        `/v1/intake/items/mentions?${q ? `q=${encodeURIComponent(q)}` : ""}`,
      ),
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
      ...(intake.data?.items ?? []).map((item) => ({
        type: "intake_item" as const,
        id: item.id,
        label: intakeMentionLabel(item.title),
        title: item.title,
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
    intake.data,
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
        intake.isLoading ||
        categories.isLoading),
  };
}

export function useSeedMentionReferences(seeds: readonly ChatReferenceSeed[]): {
  references: ConversationReference[];
  isBlocked: boolean;
  retry: () => void;
} {
  const uniqueSeeds = useMemo(
    () => [...new Map(seeds.map((seed) => [`${seed.type}:${seed.id}`, seed])).values()],
    [seeds],
  );
  const query = useQuery({
    queryKey: MENTION_SOURCE_KEYS.intakeSeed(uniqueSeeds.map((seed) => `${seed.type}:${seed.id}`)),
    enabled: uniqueSeeds.length > 0,
    staleTime: 30_000,
    queryFn: async () => {
      const resolved = await Promise.all(
        uniqueSeeds.map(async (seed): Promise<ConversationReference | null> => {
          if (seed.type === "intake_item") {
            const response = await apiRequest<{ items: IntakeMentionItem[] }>(
              `/v1/intake/items/mentions?id=${encodeURIComponent(seed.id)}`,
            );
            const item = response.items[0];
            return item
              ? { type: "intake_item", id: item.id, label: intakeMentionLabel(item.title) }
              : null;
          }
          const endpoint = seed.type === "knowledge_source" ? "knowledge-sources" : `${seed.type}s`;
          const item = await apiRequest<{
            id: string;
            name?: string | null;
            title?: string | null;
            display_name?: string | null;
            workflow_name?: string | null;
          }>(`/v1/${endpoint}/${encodeURIComponent(seed.id)}`);
          const title = item.name ?? item.title ?? item.display_name ?? item.workflow_name ?? "";
          return {
            type: seed.type,
            id: item.id,
            label: mentionLabel(title, seed.type === "execution" ? "Ausführung" : seed.type),
          };
        }),
      );
      return resolved.filter((reference): reference is ConversationReference => reference !== null);
    },
  });
  return {
    references: query.data ?? [],
    isBlocked:
      uniqueSeeds.length > 0 &&
      (query.isPending || query.isError || query.data?.length !== uniqueSeeds.length),
    retry: () => void query.refetch(),
  };
}
