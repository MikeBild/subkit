// Tool registry interface — surface-aware catalog of every tool the
// engine exposes. Two providers feed it (StaticToolProvider for
// MCP-native handlers, ConversationToolProvider for the existing
// conversation tool map). See providers/ for implementations.

import type { ToolDescriptor, ToolSurface } from "./types.ts";

/** Surface-mode-scoped catalog request. */
export interface ToolListFilter {
  readonly surface: ToolSurface;
  /** When `surface==='mcp'`, the principal's MCP mode (product /
   *  authoring / admin) determines which tools are visible. Chat sees
   *  every tool regardless of this. */
  readonly mcpMode?: "product" | "authoring" | "admin";
  /** Read-only flag derived from the principal's permission set. */
  readonly readOnly?: boolean;
  /** Skills loaded in the current session. Tools whose `requires_skill`
   *  is not in this set are hidden. Empty set means "no gated tools." */
  readonly loadedSkills?: ReadonlySet<string>;
}

/** Result of resolving a tool by name. Carries both the public
 *  descriptor and the private executor (the dispatcher hides the
 *  executor from callers). */
export interface ToolEntry {
  readonly descriptor: ToolDescriptor;
  /** Executor reference — `unknown` here to keep the registry interface
   *  free of conversation-tool / MCP-handler coupling. Each provider
   *  attaches its own executor shape; the dispatcher knows how to
   *  invoke it via the provider that resolved the name. */
  readonly executor: unknown;
}

/** Provider that contributes tools to the registry. The registry is
 *  the union of every provider's catalog; the first provider that
 *  resolves a name wins. */
export interface ToolProvider {
  readonly name: string;
  list(filter: ToolListFilter): readonly ToolDescriptor[];
  resolve(name: string, filter: ToolListFilter): ToolEntry | undefined;
}

/** Public registry surface. Implementations live in
 *  `apps/engine/src/tools/providers/`. */
export interface ToolRegistry {
  list(filter: ToolListFilter): readonly ToolDescriptor[];
  get(name: string, filter: ToolListFilter): ToolEntry | undefined;
}

/** Build a registry from an ordered list of providers. The first
 *  provider that resolves a tool name wins; duplicate names across
 *  providers are flagged at construction time. */
export function buildRegistry(providers: readonly ToolProvider[]): ToolRegistry {
  // Detect cross-provider name collisions eagerly so we fail at boot,
  // not at first call. We enumerate every surface × mode combination
  // because a tool name visible only in MCP admin mode can still collide
  // with another provider's tool that lives only on chat. Resolvers
  // still gate visibility at list() time; collisions are a registration
  // error regardless of which surface asks.
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
