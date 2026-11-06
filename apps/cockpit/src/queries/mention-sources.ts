import type { components } from "@cli-core/engine-api/openapi";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { apiCall } from "@/api/call";
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

const MENTION_SOURCE_KEYS = {
  workflows: (q: string) => ["catalog-workflow-index", "mention-source", q] as const,
  connectors: (q: string) => ["catalog-connector-index", "mention-source", q] as const,
  sources: (q: string) => ["knowledge", "mention-source", q] as const,
  skills: (q: string) => ["skills", "mention-source", q] as const,
  files: (q: string) => ["files", "mention-source", q] as const,
  intake: (q: string) => ["intake", "mention-source", q] as const,
  intakeSeed: (ids: readonly string[]) => ["intake", "mention-seed", ids] as const,
};

const KNOWLEDGE_PAGE = 8;

function skillLabel(skill: { slug: string | null; title: string }): string {
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

type WorkflowCategory = components["schemas"]["WorkflowListResponse"]["categories"][number];

export function useWorkflowCategories(enabled: boolean): {
  categories: WorkflowCategory[];
  isLoading: boolean;
} {
  const query = useQuery({
    queryKey: ["chat", "starter-catalog"],
    enabled,
    staleTime: 30_000,
    queryFn: () => apiCall("get", "/v1/workflows", { query: { limit: 1 } }),
  });
  return { categories: query.data?.categories ?? [], isLoading: enabled && query.isLoading };
}

function search(q: string): { q?: string } {
  return q ? { q } : {};
}

async function seedReference(seed: ChatReferenceSeed): Promise<ConversationReference | null> {
  const path = { id: seed.id };
  switch (seed.type) {
    case "intake_item": {
      const response = await apiCall("get", "/v1/intake/items/mentions", {
        query: { id: seed.id },
      });
      const item = response.items[0];
      return item
        ? { type: "intake_item", id: item.id, label: intakeMentionLabel(item.title) }
        : null;
    }
    case "workflow": {
      const item = await apiCall("get", "/v1/workflows/{id}", { path });
      return { type: seed.type, id: item.id, label: mentionLabel(item.name, seed.type) };
    }
    case "connector": {
      const item = await apiCall("get", "/v1/connectors/{id}", { path });
      return { type: seed.type, id: item.id, label: mentionLabel(item.display_name, seed.type) };
    }
    case "skill": {
      const item = await apiCall("get", "/v1/skills/{id}", { path });
      return { type: seed.type, id: item.id, label: mentionLabel(item.title, seed.type) };
    }
    case "knowledge_source": {
      const item = await apiCall("get", "/v1/knowledge-sources/{id}", { path });
      return { type: seed.type, id: item.id, label: mentionLabel(item.name, seed.type) };
    }
    case "execution": {
      const item = await apiCall("get", "/v1/executions/{id}", { path });
      return {
        type: seed.type,
        id: item.id,
        label: mentionLabel(item.workflow_name ?? "", "Ausführung"),
      };
    }
  }
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
    queryFn: () => apiCall("get", "/v1/workflows", { query: { limit: PAGE, ...search(q) } }),
  });
  const connectors = useQuery({
    queryKey: MENTION_SOURCE_KEYS.connectors(q),
    enabled: active && canConnectors,
    staleTime: 30_000,
    placeholderData: (previous) => previous,
    queryFn: () => apiCall("get", "/v1/connectors", { query: { limit: PAGE, ...search(q) } }),
  });

  const sources = useQuery({
    queryKey: MENTION_SOURCE_KEYS.sources(q),
    enabled: active && canSources,
    staleTime: 30_000,
    placeholderData: (previous) => previous,
    queryFn: () =>
      apiCall("get", "/v1/knowledge-sources", {
        query: { limit: KNOWLEDGE_PAGE, ...search(q) },
      }),
  });
  const skills = useQuery({
    queryKey: MENTION_SOURCE_KEYS.skills(q),
    enabled: active && canSkills,
    staleTime: 30_000,
    placeholderData: (previous) => previous,
    queryFn: () =>
      apiCall("get", "/v1/skills", {
        query: { status: "active", limit: KNOWLEDGE_PAGE, ...search(q) },
      }),
  });
  const files = useQuery({
    queryKey: MENTION_SOURCE_KEYS.files(q),
    enabled: active && canFiles,
    staleTime: 30_000,
    placeholderData: (previous) => previous,
    queryFn: () => apiCall("get", "/v1/files", { query: { limit: KNOWLEDGE_PAGE, ...search(q) } }),
  });
  const intake = useQuery({
    queryKey: MENTION_SOURCE_KEYS.intake(q),
    enabled: active && canIntake,
    staleTime: 30_000,
    placeholderData: (previous) => previous,
    queryFn: () => apiCall("get", "/v1/intake/items/mentions", { query: search(q) }),
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
      const resolved = await Promise.all(uniqueSeeds.map(seedReference));
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
