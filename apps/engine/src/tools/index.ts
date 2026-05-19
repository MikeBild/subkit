// apps/engine/src/tools — unified tool palette.
//
// Public surface: types, registry interface, registry builder, the
// dispatcher, policy gate, providers, and the shared registry
// singleton. Consumers outside this package import only from this
// barrel.

export * from "./dispatcher.ts";
export * from "./policy.ts";
export { conversationToolProvider } from "./providers/conversation.ts";
export { staticToolProvider } from "./providers/static.ts";
export * from "./registry.ts";
export * from "./types.ts";

import { conversationToolProvider } from "./providers/conversation.ts";
import { staticToolProvider } from "./providers/static.ts";
import { buildRegistry, type ToolRegistry } from "./registry.ts";

// Module-level singleton. The registry is pure functions over the
// providers; rebuilding it per call burns the boot-time collision
// sweep on every dispatch. Both per-surface adapters and any future
// caller must import from here rather than constructing their own
// registry — otherwise a future provider-order or filter-default
// change would silently diverge across surfaces.
let UNIFIED_REGISTRY: ToolRegistry | null = null;
export function getUnifiedRegistry(): ToolRegistry {
  if (!UNIFIED_REGISTRY) {
    UNIFIED_REGISTRY = buildRegistry([staticToolProvider, conversationToolProvider]);
  }
  return UNIFIED_REGISTRY;
}
