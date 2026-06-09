// Subsystem entry point for `mcp`. Route files (apps/engine/src/http/routes/*)
// and other cross-subsystem consumers MUST import from this barrel rather
// than reaching into internal files — enforced by the `route_layering`
// audit invariant (apps/engine/scripts/audit-invariants.ts).
//
// The MCP *client* (subkit consuming external MCP servers, #171) lives under
// `./client/`; its registry / pool / schema-drift surface is re-exported here.
// The MCP *server* side (server.ts, adapter.ts, …) is consumed via its own
// explicit imports and is not aggregated here to keep the barrel light.

export * from "./client/pool.ts";
export * from "./client/registry.ts";
export * from "./client/schema-drift.ts";
export { reconcileMcpServersFromConfig } from "./config-seed.ts";
