// Where `sk workflows invoke-snippet` gets its snippet from.
//
// The engine knows what the terminal cannot: the workflow's sample input and
// the public address callers reach it at. So the snippet is the engine's —
// `GET /v1/workflows/{id}/invocation`, the same read the workflow page uses —
// and the two surfaces hand out the same call, with an input that passes the
// workflow's own validation.
//
// The command still has to print something when the engine cannot answer.
// It renders locally, with the shared renderer, in exactly three cases: the
// engine is unreachable, it does not know the workflow, or it has no public
// address configured. That snippet names the profile's engine URL and an empty
// input, and the caller is told so. Any other failure — a rejected key, a
// missing permission — is an error, not a reason to print a different call.

import { isEngineError, isTransportError } from "@cli-core/errors";
import {
  type InvokeEnvironment,
  type InvokeSnippetLanguage,
  renderInvokeSnippet,
} from "@shared/invoke-snippet.ts";
import type { EngineClient } from "../engine-client.ts";

export type LocalSnippetReason = "engine_unreachable" | "workflow_unknown" | "no_public_address";

export interface InvokeSnippet {
  snippet: string;
  /** The address the snippet posts to. */
  engine_url: string;
  source: "engine" | "local";
  /** Why the engine's snippet was not used. Present when `source` is `local`. */
  local_reason?: LocalSnippetReason;
}

// The invocation route takes a workflow id, and an id is a UUID. Anything
// else cannot name a workflow there, so it is not asked.
const WORKFLOW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How long the lookup may take before the command falls back to rendering
 *  locally — it prints a snippet, it should not hang on a dead address. */
export const INVOCATION_LOOKUP_TIMEOUT_MS = 5_000;

export async function resolveInvokeSnippet(p: {
  client: Pick<EngineClient, "getWorkflowInvocation">;
  /** The engine URL of the active profile, for the local rendering. */
  profileEngineUrl: string;
  workflowId: string;
  lang: InvokeSnippetLanguage;
  environment: InvokeEnvironment;
}): Promise<InvokeSnippet> {
  const local = (local_reason: LocalSnippetReason): InvokeSnippet => ({
    snippet: renderInvokeSnippet({
      lang: p.lang,
      engineUrl: p.profileEngineUrl,
      workflowId: p.workflowId,
      environment: p.environment,
    }),
    engine_url: p.profileEngineUrl,
    source: "local",
    local_reason,
  });

  if (!WORKFLOW_ID.test(p.workflowId)) return local("workflow_unknown");
  let invocation: Awaited<ReturnType<EngineClient["getWorkflowInvocation"]>>;
  try {
    invocation = await p.client.getWorkflowInvocation(p.workflowId);
  } catch (err) {
    if (isTransportError(err)) return local("engine_unreachable");
    if (isEngineError(err) && err.status === 404) return local("workflow_unknown");
    throw err;
  }
  const snippet = invocation.http.snippets?.[p.environment]?.[p.lang];
  if (!invocation.base_url || !snippet) return local("no_public_address");
  return { snippet, engine_url: invocation.base_url, source: "engine" };
}
