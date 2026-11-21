import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiCall } from "@/api/call";
import { listIntakeClips, listIntakeProposals } from "@/api/intake";

export const KEYS = {
  entries: ["intake", "clips", "all"] as const,
  proposals: ["intake", "proposals"] as const,
  sources: ["catalog", "knowledge", "kn"] as const,
  skills: ["catalog", "skills", "kn"] as const,
  files: ["catalog", "files", "kn"] as const,
  source: (id: string) => ["knowledge-source", id] as const,
  skill: (id: string) => ["skill", id] as const,
  file: (id: string) => ["file", id] as const,
  entry: (id: string) => ["intake", "clip", id] as const,
};

const PAGE = 100;
const MAX_PAGES = 20;

export async function allPages<T>(
  load: (offset: number) => Promise<{ items: T[]; total: number }>,
): Promise<{ items: T[]; total: number }> {
  const first = await load(0);
  const items = [...first.items];
  for (let page = 1; items.length < first.total && page < MAX_PAGES; page++) {
    const next = await load(items.length);
    if (next.items.length === 0) break;
    items.push(...next.items);
  }
  return { items, total: first.total };
}

export function useEntries() {
  return useQuery({ queryKey: KEYS.entries, queryFn: () => listIntakeClips() });
}

export function useProposals() {
  return useQuery({ queryKey: KEYS.proposals, queryFn: () => listIntakeProposals() });
}

export function useSources() {
  return useQuery({
    queryKey: KEYS.sources,
    queryFn: () =>
      allPages((offset) =>
        apiCall("get", "/v1/knowledge-sources", { query: { limit: PAGE, offset } }),
      ),
  });
}

export function useSkills() {
  return useQuery({
    queryKey: KEYS.skills,
    queryFn: () =>
      allPages((offset) => apiCall("get", "/v1/skills", { query: { limit: PAGE, offset } })),
  });
}

export function useFiles() {
  return useQuery({
    queryKey: KEYS.files,
    queryFn: () =>
      allPages((offset) => apiCall("get", "/v1/files", { query: { limit: PAGE, offset } })),
  });
}

export function useMarkdownRefs() {
  const files = useFiles();
  const skills = useSkills();
  const sources = useSources();
  return [
    ...(files.data?.items ?? []).map((f) => ({
      kind: "file" as const,
      name: f.reference ?? f.slug ?? f.filename,
    })),
    ...(skills.data?.items ?? []).map((s) => ({ kind: "skill" as const, name: s.slug ?? s.title })),
    ...(sources.data?.items ?? []).map((s) => ({ kind: "source" as const, name: s.slug })),
  ];
}

export function refreshKnowledge(client: QueryClient): Promise<unknown> {
  return Promise.all([
    client.invalidateQueries({ queryKey: ["intake"] }),
    client.invalidateQueries({ queryKey: ["catalog"] }),
    client.invalidateQueries({ queryKey: ["attention"] }),
  ]);
}

export function useRefreshKnowledge() {
  const client = useQueryClient();
  return () => refreshKnowledge(client);
}
