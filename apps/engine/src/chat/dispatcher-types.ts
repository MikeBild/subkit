// Shared types for the dispatcher + its extracted helpers.
//
// Kept in its own file so `elicit-routing.ts` (which imports
// `DispatchOutcome`) doesn't pull in the dispatcher's full module
// graph, which would create a circular dependency back through
// `dispatcher.ts` → `elicit-routing.ts` → `dispatcher.ts`.

import type { RunLoopResult } from "../conversations/loop.ts";

/** Envelope handed to the injected enqueue callback when a slash-run
 *  fires. Mirrors the shape of `ExecutionRunJob` so callers can
 *  forward it straight into pg-boss. */
export interface DispatchRunEnqueue {
  tenant_id: string;
  workflow_id: string;
  execution_id: string;
  input: Record<string, string>;
  request_source: "chat";
  trace_id: string | null;
}

export interface DispatchOutcome {
  status: "ok" | "workspace_not_found" | "ignored" | "help" | "approved" | "rejected";
  conversation_id?: string;
  approval_sent?: boolean;
  loop?: RunLoopResult;
  /** Set when the dispatcher routed a `/subkit run` slash command. */
  execution_id?: string;
  workflow_id?: string;
}
