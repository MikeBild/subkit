// Shared types for the dispatcher + its extracted helpers.
//
// Kept in its own file so `elicit-routing.ts` (which imports
// `DispatchOutcome`) doesn't pull in the dispatcher's full module
// graph, which would create a circular dependency back through
// `dispatcher.ts` → `elicit-routing.ts` → `dispatcher.ts`.

import type { RunLoopResult } from "../conversations/loop.ts";

export interface DispatchOutcome {
  status: "ok" | "workspace_not_found" | "ignored" | "help" | "approved" | "rejected";
  conversation_id?: string;
  approval_sent?: boolean;
  loop?: RunLoopResult;
}
