// Subsystem entry point for `mcp`. Route files (apps/engine/src/http/routes/*)
// and other cross-subsystem consumers MUST import from this barrel rather
// than reaching into internal files — enforced by the `route_layering`
// audit invariant (apps/engine/scripts/audit-invariants.ts).
//
// The MCP *client* (subkit consuming external MCP servers, #171) lives under
// `./client/`; its registry / pool / schema-drift surface is re-exported here.
// The MCP *server* side (server.ts, adapter.ts, …) is consumed via its own
// explicit imports and is not aggregated here to keep the barrel light.

export {
  McpDbOAuthClientProvider,
  type McpDbOAuthClientProviderInput,
  makeMcpOAuthProvider,
} from "./client/oauth-provider.ts";
export { buildMcpOAuthRedirectUri, MCP_OAUTH_CALLBACK_PATH } from "./client/oauth-redirect.ts";
// Production surface of the client pool ONLY. The pool's `__set*ForTests` /
// `__reset*ForTests` seams (and the structural fake types backing them) are
// deliberately NOT re-exported — tests import them from the inner module
// (`./client/pool.ts`) so the barrel never advertises a test seam to
// production consumers.
export {
  connectServerById,
  evictServer,
  evictTenant,
  getTenantMcpTools,
  type InvokeRemoteToolInput,
  type InvokeRemoteToolResult,
  invalidateCachedManifest,
  invokeRemoteTool,
  type RemoteToolDescriptor,
  type TenantMcpToolSet,
} from "./client/pool.ts";
export * from "./client/registry.ts";
export * from "./client/schema-drift.ts";
// `__setSdkAuthForTests` stays on the inner module (`./client/sdk-auth.ts`)
// for the same reason — only the production wrapper is barrel-visible.
export { sdkAuth } from "./client/sdk-auth.ts";
export { reconcileMcpServersFromConfig } from "./config-seed.ts";
