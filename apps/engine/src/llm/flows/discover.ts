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

/**
 * Kind-aware shape check for the unconstrained `draft: Record` field
 * on a discover artifact. The Zod schema only enforces presence of a
 * record; this catches LLM hallucinations where the draft is
 * structurally unusable (missing the minimum fields the downstream
 * candidate persistence requires).
 *
 * Returns null when the draft passes; otherwise a list of human
 * readable issues. Designed to compose into a "drop or surface"
 * decision in `runDiscoverFlow`.
 */
export function validateDiscoverDraft(artifact: DiscoverArtifact): string[] | null {
  const draft = artifact.draft;
  const issues: string[] = [];
  const has = (k: string) => k in draft && draft[k] !== null && draft[k] !== undefined;
  switch (artifact.kind) {
    case "connector":
      if (!has("name") && !has("title")) issues.push("connector draft requires `name`");
      if (!has("base_url") && !has("template_id") && !has("driver"))
        issues.push("connector draft requires one of `base_url`, `template_id`, `driver`");
      break;
    case "skill":
      if (!has("title")) issues.push("skill draft requires `title`");
      if (!has("body") && !has("content") && !has("instructions"))
        issues.push("skill draft requires one of `body`, `content`, `instructions`");
      break;
    case "knowledge_source":
      if (!has("name") && !has("slug")) issues.push("knowledge_source draft requires `name`");
      if (!has("content") && !has("body") && !has("source_uri"))
        issues.push(
          "knowledge_source draft requires one of `content`, `body`, `source_uri`",
        );
      break;
  }
  return issues.length > 0 ? issues : null;
}

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
  /** Drafts the LLM emitted that failed kind-aware validation. Surfaced for
   *  operator review (drift signal) but never persisted as candidates. */
  rejected: Array<{ artifact: DiscoverArtifact; issues: string[] }>;
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

  // Kind-aware validation pass: drop any artifact whose draft is
  // structurally unusable (missing fields downstream candidate
  // persistence relies on). The rejected list is surfaced so the
  // discovery service can log a drift signal without persisting the
  // broken draft.
  const raw = r.object?.artifacts ?? [];
  const accepted: DiscoverArtifact[] = [];
  const rejected: DiscoverResult["rejected"] = [];
  for (const a of raw) {
    const issues = validateDiscoverDraft(a);
    if (issues) rejected.push({ artifact: a, issues });
    else accepted.push(a);
  }

  return {
    artifacts: accepted,
    rejected,
    raw_text: r.text,
    model_used: r.model_used,
    fell_back: r.fell_back,
  };
}
