// Pure formatter for the answer-sources footer, shared by the Ink
// transcript, the headless `--output text` path, and the readline REPL.
// No React — safe to import from any surface.

import type { Citation } from "@cli-core/index.ts";

/** "Sources: Weather Runbook, GitHub API" — deduped display names, id
 *  fallback when a source has no name. Returns null when there is nothing
 *  to show, so callers render no footer on citation-less answers. */
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

/** The last assistant message's citations, if any — the terminal answer's
 *  sources, for the text/repl footer. */
export function terminalAssistantCitations(
  messages: ReadonlyArray<{ role: string; citations?: Citation[] }>,
): Citation[] | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "assistant") return m.citations;
  }
  return undefined;
}
