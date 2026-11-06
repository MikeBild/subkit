import { isEngineError, isTransportError } from "@cli-core/errors";
import {
  type InvokeEnvironment,
  type InvokeSnippetLanguage,
  renderInvokeSnippet,
} from "@shared/invoke-snippet.ts";
import type { EngineClient } from "../engine-client.ts";

export type LocalSnippetReason = "engine_unreachable" | "workflow_unknown" | "no_public_address";

interface InvokeSnippet {
  snippet: string;
  engine_url: string;
  source: "engine" | "local";
  local_reason?: LocalSnippetReason;
}

const WORKFLOW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const INVOCATION_LOOKUP_TIMEOUT_MS = 5_000;

export async function resolveInvokeSnippet(p: {
  client: Pick<EngineClient, "getWorkflowInvocation">;
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
