import type { Db } from "../../db/client.ts";
import type { WorkflowDef } from "../../workflows/types.ts";
import { invoke } from "../core/invoke.ts";
import type { EnhancedPrompt } from "../types.ts";

export interface GenerateParams {
  tenant_id: string;
  description: string;
  connector_id?: string | undefined;
  workflow_id?: string | undefined;
  preview?: boolean | undefined;
}

export interface GenerateResult {
  draft_workflow: Partial<WorkflowDef>;
  raw_text: string;
  included_skill_ids: string[];
  included_chunk_ids: string[];
  tokens: EnhancedPrompt["token_counts"];
  model_used: string;
  fell_back: boolean;
}

export async function runGenerateFlow(p: GenerateParams, exec?: Db): Promise<GenerateResult> {
  const r = await invoke<Partial<WorkflowDef>>(
    {
      flow: "generate",
      tenant_id: p.tenant_id,
      user_turns: [{ role: "user", content: p.description }],
      ...(p.connector_id ? { connector_id: p.connector_id } : {}),
      ...(p.workflow_id ? { workflow_id: p.workflow_id } : {}),
    },
    exec,
  );
  return {
    draft_workflow: r.object ?? {},
    raw_text: r.text,
    included_skill_ids: r.assembled.prompt.included_skill_ids,
    included_chunk_ids: r.assembled.prompt.included_chunk_ids,
    tokens: r.assembled.prompt.token_counts,
    model_used: r.model_used,
    fell_back: r.fell_back,
  };
}
