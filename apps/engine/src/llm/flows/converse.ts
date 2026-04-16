// `converse` flow — single-turn stub of the authoring conversation.
//
// v1 assembles the same enhanced prompt as the other flows and runs the
// model for a single turn with an empty tool palette. The full
// multi-turn tool-using loop (reader tools, connector probes, workflow
// edits, etc.) ships in P10.
//
// TODO(P10): replace this stub with a real tool-calling loop. The loop
// should:
//   - pull the prior conversation turns from `conversations` + `messages`
//   - expose a typed tool palette (list_skills, search_docs, ...)
//   - iterate until the model returns a final assistant turn or tool
//     budget is exhausted
//   - persist each turn + tool call back to the conversations tables

import type { Db } from "../../db/client.ts";
import { assembleEnhancedPrompt } from "../context.ts";
import { callWithFallback, resolveModelRoute } from "../provider.ts";
import type { EnhancedPrompt } from "../types.ts";

export interface ConverseParams {
  tenant_id: string;
  conversation_id?: string | undefined;
  user_message: string;
  connector_id?: string | undefined;
  workflow_id?: string | undefined;
}

export interface ConverseResult {
  assistant_message: string;
  conversation_id: string | null;
  included_skill_ids: string[];
  tokens: EnhancedPrompt["token_counts"];
  model_used: string;
  fell_back: boolean;
}

export async function runConverseFlow(p: ConverseParams, exec?: Db): Promise<ConverseResult> {
  const route = await resolveModelRoute(p.tenant_id, exec);
  const prompt = await assembleEnhancedPrompt(
    {
      tenant_id: p.tenant_id,
      flow: "converse",
      ...(p.connector_id ? { connector_id: p.connector_id } : {}),
      ...(p.workflow_id ? { workflow_id: p.workflow_id } : {}),
      user_turns: [{ role: "user", content: p.user_message }],
      max_tokens: route.context_cap,
      model: route.primary,
    },
    exec,
  );
  const { result, model_used, fell_back } = await callWithFallback<{ text?: string }>(
    { flow: "converse", route, prompt },
    exec,
  );
  // With an empty tool palette the model just returns a single text
  // turn. We surface the plain text to the caller.
  const assistant_message = result.text ?? "";
  return {
    assistant_message,
    conversation_id: p.conversation_id ?? null,
    included_skill_ids: prompt.included_skill_ids,
    tokens: prompt.token_counts,
    model_used,
    fell_back,
  };
}
