// Candidates for the composer's `@`-picker.
//
// The engine already searches workflows and connectors server-side (`?q=`),
// so the picker asks for a short ranked page per keystroke instead of
// holding the whole catalogue in the browser. Only objects the session may
// read are offered — the server is the authority, this merely avoids asking
// for a list that would come back 403.

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { apiRequest } from "@/api/client";
import { isMentionableLabel, type MentionCandidate, rankCandidates } from "@/lib/mentions";
import { useDebouncedValue } from "@/lib/use-debounced-value";

const PAGE = 50;

/** Query-key roots shared with the catalogue pages, so a workflow or
 *  connector created elsewhere in the Cockpit refreshes the picker too. */
export const MENTION_SOURCE_KEYS = {
  workflows: (q: string) => ["catalog-workflow-index", "mention-source", q] as const,
  connectors: (q: string) => ["catalog-connector-index", "mention-source", q] as const,
};

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
    ];
    // The server ranked by its own relevance; the local pass only orders
    // prefix hits first so what the person typed sits at the top.
    return rankCandidates(all, query ?? "");
  }, [workflows.data, connectors.data, query]);

  return {
    candidates,
    isLoading: active && (workflows.isLoading || connectors.isLoading),
  };
}
