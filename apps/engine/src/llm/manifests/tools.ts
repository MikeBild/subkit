import { listTools } from "../../conversations/tools/index.ts";

export interface ToolManifestEntry {
  name: string;
  category: string;
  one_liner: string;
}

export interface ToolManifest {
  names: ReadonlySet<string>;
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

export function getToolManifest(): ToolManifest {
  if (!cached) cached = build();
  return cached;
}
