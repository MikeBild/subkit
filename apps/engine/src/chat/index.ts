// Public API barrel for the `chat` subsystem. Routes and other
// subsystems must import from this entry point only — see the
// route_layering check at apps/engine/scripts/audit-invariants.ts.

export * from "./adapter.ts";
export * from "./api.ts";
// `dispatcher.ts` carries the `handleChatEvent` entry point used by
// `http/routes/chat.ts`. Re-exported here so a future second caller
// (e.g. an MCP capability or a webhook handler) can reach it through
// the barrel without tripping the route_layering FAIL gate.
export * from "./dispatcher.ts";
export * from "./hydrate.ts";
export * from "./registry.ts";
export type { SlackAdapterOptions } from "./slack/adapter.ts";
export { SlackAdapter } from "./slack/adapter.ts";
// `sync-turn.ts` carries `runChatTurnSync`, the synchronous Google-Chat
// entry point used by `http/routes/chat.ts`. Re-exported here so the route
// reaches it through the barrel without tripping the route_layering gate.
export * from "./sync-turn.ts";
export * from "./types.ts";
