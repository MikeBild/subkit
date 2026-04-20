// ToolManifest — live reflection of the conversation tool registry.
//
// The actual tool *definitions* reach the LLM via the AI SDK's
// `tools` parameter — we don't re-inject them into the prompt.
// The manifest's role is to give scanners and tests a single source
// of truth for "what tool names exist right now", so the assistant
// cannot narrate calls to tools that don't exist.

import { listTools } from "../../conversations/tools/index.ts";

export interface ToolManifestEntry {
  name: string;
  category: string;
  /** First sentence of the description — short label rendered in violation messages. */
  one_liner: string;
}

export interface ToolManifest {
  /** Set of all registered tool names. */
  names: ReadonlySet<string>;
  /** Detailed entries, keyed by name. */
  entries: ReadonlyMap<string, ToolManifestEntry>;
}

let cached: ToolManifest | undefined;

function build(): ToolManifest {
  const tools = listTools();
  const entries = new Map<string, ToolManifestEntry>();
  for (const t of tools) {
    const oneLiner = t.description.split(/(?<=\.|!|\?)\s/)[0]?.trim() ?? t.description;
    entries.set(t.name, {
      name: t.name,
      category: t.category,
      one_liner: oneLiner,
    });
  }
  return { names: new Set(entries.keys()), entries };
}

/** Live ToolManifest. Cached after first build for cheap repeated reads. */
export function getToolManifest(): ToolManifest {
  if (!cached) cached = build();
  return cached;
}

/** Test/restart hook — drop the cache so the next call rebuilds. */
export function refreshToolManifest(): void {
  cached = undefined;
}
