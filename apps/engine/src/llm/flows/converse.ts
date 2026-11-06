import type { Db } from "../../db/client.ts";
import { invoke } from "../runtime/invoke.ts";
import type { EnhancedPrompt } from "../types.ts";

interface ConverseParams {
  tenant_id: string;
  conversation_id?: string | undefined;
  user_message: string;
  connector_id?: string | undefined;
  workflow_id?: string | undefined;
}

interface ConverseResult {
  assistant_message: string;
  conversation_id: string | null;
  included_skill_ids: string[];
  tokens: EnhancedPrompt["token_counts"];
  model_used: string;
  fell_back: boolean;
}

export async function runConverseFlow(p: ConverseParams, exec?: Db): Promise<ConverseResult> {
  const r = await invoke(
    {
      flow: "converse",
      tenant_id: p.tenant_id,
      user_turns: [{ role: "user", content: p.user_message }],
      ...(p.connector_id ? { connector_id: p.connector_id } : {}),
      ...(p.workflow_id ? { workflow_id: p.workflow_id } : {}),
    },
    exec,
  );
  return {
    assistant_message: r.text ?? "",
    conversation_id: p.conversation_id ?? null,
    included_skill_ids: r.assembled.prompt.included_skill_ids,
    tokens: r.assembled.prompt.token_counts,
    model_used: r.model_used,
    fell_back: r.fell_back,
  };
}
