// Shared elicitation-outcome applier.
//
// When an `ask_user_*` elicitation resolves with the operator's answer,
// two things must happen before the next LLM turn:
//
//   1. `maybeCacheDraftCredentialFromElicitation` — seed the
//      draft-credential cache so `probe_connector_draft` can
//      authenticate before the connector row exists.
//   2. `maybeAutoPersistFromElicitation` — when the carrier elicitation
//      holds a `commit_intent`, apply the proposed write atomically and
//      inject the synthetic tool-call/result rows.
//
// Both the DB-pause resume path (`service/elicit.ts#respondElicitation`)
// and the MCP-native in-process bridge resolution
// (`ask-user/common.ts#pauseForUserInput`, form path) need this exact
// sequence. Factored here so there is ONE implementation — a divergence
// between the two paths is how the credential cache or the auto-persist
// dispatch silently goes missing on one surface.

import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import {
  type AutoPersistDispatch,
  maybeAutoPersistFromElicitation,
  maybeCacheDraftCredentialFromElicitation,
} from "./auto-persist.ts";

export interface ApplyElicitationOutcomeInput {
  tenant_id: string;
  conversation_id: string;
  actor_id: string | null;
  /** Resolved principal of the answering actor — threaded into the
   *  auto-persist dispatcher for RBAC-gated intents (run_workflow). */
  principal?: ResolvedPrincipal | null;
  /** The resolved carrier elicitation row. */
  elicitation: {
    id: string;
    tool_name: string;
    input: unknown;
  };
  /** The operator's answer — shape depends on the tool. */
  output: unknown;
  /** Surface the resume runs on — `"chat"` blocks mutating
   *  commit_intents (read-only channel); see auto-persist.ts. */
  surface?: "sk_headless" | "sk_interactive" | "mcp" | "web" | "chat";
  db: Db;
}

/**
 * Run the credential-cache hook then the auto-persist dispatcher for a
 * resolved elicitation. Returns the `AutoPersistDispatch` so callers can
 * branch on `dispatched` (e.g. to short-circuit committed conversations).
 */
export async function applyElicitationOutcome(
  p: ApplyElicitationOutcomeInput,
): Promise<AutoPersistDispatch> {
  // Cache the credential FIRST — if auto-persist then fires a
  // successful `save_connector_draft`, `saveConnectorAtomic` clears the
  // cache as part of the same call. The cache is what
  // `probe_connector_draft` reads when no `credentials` row exists yet.
  await maybeCacheDraftCredentialFromElicitation({
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    elicitation_output: p.output,
    elicitation: { tool_name: p.elicitation.tool_name },
    db: p.db,
  });
  return maybeAutoPersistFromElicitation({
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    actor_id: p.actor_id,
    ...(p.principal !== undefined ? { principal: p.principal } : {}),
    ...(p.surface ? { surface: p.surface } : {}),
    elicitation_output: p.output,
    elicitation: {
      id: p.elicitation.id,
      tool_name: p.elicitation.tool_name,
      input: p.elicitation.input,
    },
    db: p.db,
  });
}
