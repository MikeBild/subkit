// `discover` flow — file contents → structured artifact proposals.
//
// Asks the LLM to identify three kinds of artifacts:
//   - Connectors (OpenAPI specs, code with API calls, config files)
//   - Skills (SOPs, compliance docs, best-practice runbooks)
//   - Knowledge Sources (glossaries, reference material)

import { z } from "zod";
import type { Db } from "../../db/client.ts";
import { invoke } from "../core/invoke.ts";

export const DiscoverArtifactSchema = z.object({
  kind: z.enum(["connector", "skill", "knowledge_source"]),
  title: z.string(),
  description: z.string(),
  draft: z.record(z.string(), z.unknown()),
  evidence_excerpts: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(100),
});
export type DiscoverArtifact = z.infer<typeof DiscoverArtifactSchema>;

const DiscoverEnvelopeSchema = z.object({
  artifacts: z.array(DiscoverArtifactSchema),
});
export type DiscoverEnvelope = z.infer<typeof DiscoverEnvelopeSchema>;

export interface DiscoverParams {
  tenant_id: string;
  run_id: string;
  /** { filename: parsedContent } map — parser output from knowledge/parsers.ts. */
  files: Record<string, string>;
}

export interface DiscoverResult {
  artifacts: DiscoverArtifact[];
  raw_text: string;
  model_used: string;
  fell_back: boolean;
}

export async function runDiscoverFlow(p: DiscoverParams, exec?: Db): Promise<DiscoverResult> {
  const userContent = [
    `Discovery run ${p.run_id}. Analyze the following files and extract artifact proposals.`,
    ...Object.entries(p.files).map(
      ([name, body]) => `\n## File: ${name}\n\`\`\`\n${body.slice(0, 8000)}\n\`\`\``,
    ),
  ].join("\n");

  const r = await invoke<DiscoverEnvelope>(
    {
      flow: "discover",
      tenant_id: p.tenant_id,
      user_turns: [{ role: "user", content: userContent }],
      schema: DiscoverEnvelopeSchema,
      telemetry_metadata: { discovery_run_id: p.run_id },
    },
    exec,
  );

  return {
    artifacts: r.object?.artifacts ?? [],
    raw_text: r.text,
    model_used: r.model_used,
    fell_back: r.fell_back,
  };
}
