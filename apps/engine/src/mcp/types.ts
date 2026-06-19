// Shared MCP types.
//
// These are intentionally thin — the SDK owns the wire shape. We only
// describe the in-process wiring (server factory inputs, auth shape).

import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";

export interface McpServerFactoryOptions {
  db: Db;
  principal: ResolvedPrincipal;
  transport: "http" | "stdio";
}

export const MCP_OFFLOAD_CHAR_CAP = 20_000;
