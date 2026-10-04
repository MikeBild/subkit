import type { ToolDescriptor, ToolSurface } from "./types.ts";

export interface ToolListFilter {
  readonly surface: ToolSurface;
  readonly mcpMode?: "product" | "authoring" | "admin";
  readonly readOnly?: boolean;
  readonly loadedSkills?: ReadonlySet<string>;
}

export interface ToolEntry {
  readonly descriptor: ToolDescriptor;
  readonly executor: unknown;
}

export interface ToolProvider {
  readonly name: string;
  list(filter: ToolListFilter): readonly ToolDescriptor[];
  resolve(name: string, filter: ToolListFilter): ToolEntry | undefined;
}

export interface ToolRegistry {
  list(filter: ToolListFilter): readonly ToolDescriptor[];
  get(name: string, filter: ToolListFilter): ToolEntry | undefined;
}

export function buildRegistry(providers: readonly ToolProvider[]): ToolRegistry {
  const seen = new Map<string, string>();
  const probeFilters: readonly ToolListFilter[] = [
    { surface: "chat" },
    { surface: "mcp", mcpMode: "product" },
    { surface: "mcp", mcpMode: "authoring" },
    { surface: "mcp", mcpMode: "admin" },
  ];
  for (const p of providers) {
    const namesForThisProvider = new Set<string>();
    for (const f of probeFilters) {
      for (const d of p.list(f)) {
        namesForThisProvider.add(d.name);
      }
    }
    for (const name of namesForThisProvider) {
      const owner = seen.get(name);
      if (owner !== undefined) {
        throw new Error(
          `tool registry collision: "${name}" registered by both "${owner}" and "${p.name}"`,
        );
      }
      seen.set(name, p.name);
    }
  }

  return {
    list(filter: ToolListFilter): readonly ToolDescriptor[] {
      const out: ToolDescriptor[] = [];
      const byName = new Map<string, ToolDescriptor>();
      for (const p of providers) {
        for (const d of p.list(filter)) {
          if (!byName.has(d.name)) {
            byName.set(d.name, d);
            out.push(d);
          }
        }
      }
      return out;
    },
    get(name, filter) {
      for (const p of providers) {
        const entry = p.resolve(name, filter);
        if (entry) return entry;
      }
      return undefined;
    },
  };
}
