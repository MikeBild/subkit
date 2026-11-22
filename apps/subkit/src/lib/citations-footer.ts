import type { Citation } from "@cli-core/index.ts";

export function formatCitationsFooter(citations: readonly Citation[] | undefined): string | null {
  if (!citations || citations.length === 0) return null;
  const seen = new Set<string>();
  const names: string[] = [];
  for (const c of citations) {
    const label = c.source_name ?? c.id;
    if (seen.has(label)) continue;
    seen.add(label);
    names.push(label);
  }
  return names.length > 0 ? `Sources: ${names.join(", ")}` : null;
}

export function terminalAssistantCitations(
  messages: ReadonlyArray<{ role: string; citations?: Citation[] }>,
): Citation[] | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "assistant") return m.citations;
  }
  return undefined;
}
