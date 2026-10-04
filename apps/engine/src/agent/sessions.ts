import { createHash } from "node:crypto";
import { z } from "@hono/zod-openapi";
import type { Db } from "../db/client.ts";
import { invoke } from "../llm/core/invoke.ts";
import { upsertFromSignal } from "../skill-candidates/service.ts";
import type { PatternSignal, SkillCandidateConfidence } from "../skill-candidates/types.ts";
import { DOMAIN_TAG_PREFIX } from "./briefing.ts";

const SAMPLE_HEAD_CHARS = 4_000;
const SAMPLE_TAIL_CHARS = 24_000;
export const TRANSCRIPT_MAX_CHARS = 1_000_000;
export const MAX_LEARNINGS_PER_SESSION = 8;

export interface AgentSessionMeta {
  agent: string;
  session_id?: string;
  repo?: string;
  domains: string[];
}

export interface ProposeLearningParams {
  tenant_id: string;
  title: string;
  body: string;
  pitfalls?: string[];
  domains: string[];
  confidence: SkillCandidateConfidence;
  evidence_summary: string;
  db: Db;
}

export function learningFingerprint(domains: string[], title: string): string {
  const normalizedTitle = title.toLowerCase().replace(/\s+/g, " ").trim();
  const domainKey = [...domains].sort().join(",");
  return createHash("sha256")
    .update(`session_learning:${domainKey}:${normalizedTitle}`)
    .digest("hex");
}

function domainTags(domains: string[]): string[] {
  return domains.map((d) => `${DOMAIN_TAG_PREFIX}${d}`);
}

export async function proposeLearning(
  p: ProposeLearningParams,
): Promise<{ action: "proposed" | "updated" | "skipped"; candidate_id: string | null }> {
  const signal: PatternSignal = {
    pattern_kind: "session_learning",
    scope: "global",
    title: p.title,
    body: p.body,
    examples: [],
    best_practices: [],
    pitfalls: p.pitfalls ?? [],
    doc_refs: [],
    fingerprint: learningFingerprint(p.domains, p.title),
    confidence: p.confidence,
    tags: domainTags(p.domains),
    evidence: [{ evidence_type: "agent_session", summary: p.evidence_summary.slice(0, 2_000) }],
  };
  return await upsertFromSignal(p.tenant_id, signal, p.db);
}

const LearningSchema = z.object({
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(4_000),
  pitfalls: z.array(z.string().min(1).max(500)).max(5).default([]),
  confidence: z.enum(["low", "medium", "high"]),
});

const DistillationSchema = z.object({
  learnings: z.array(LearningSchema).max(MAX_LEARNINGS_PER_SESSION),
});

export function transcriptLineText(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const message = (parsed.message ?? parsed) as Record<string, unknown>;
    const role = typeof message.role === "string" ? message.role : null;
    const content = message.content;
    let text: string | null = null;
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      const parts = content
        .map((block) =>
          block &&
          typeof block === "object" &&
          typeof (block as { text?: unknown }).text === "string"
            ? ((block as { text: string }).text as string)
            : "",
        )
        .filter(Boolean);
      text = parts.length > 0 ? parts.join("\n") : null;
    }
    if (!text) return null;
    return role ? `${role}: ${text}` : text;
  } catch {
    return trimmed;
  }
}

export function sampleTranscript(transcript: string): string {
  const lines = transcript.split("\n");
  const readable: string[] = [];
  for (const line of lines) {
    const text = transcriptLineText(line);
    if (text) readable.push(text);
  }
  const joined = readable.join("\n");
  if (joined.length <= SAMPLE_HEAD_CHARS + SAMPLE_TAIL_CHARS) return joined;
  return `${joined.slice(0, SAMPLE_HEAD_CHARS)}\n[…transcript truncated…]\n${joined.slice(
    joined.length - SAMPLE_TAIL_CHARS,
  )}`;
}

export interface AnalyzeAgentSessionParams {
  tenant_id: string;
  transcript: string;
  meta: AgentSessionMeta;
  db: Db;
}

export interface AnalyzeAgentSessionResult {
  learnings_found: number;
  proposed: number;
  updated: number;
  skipped: number;
}

export async function analyzeAgentSession(
  p: AnalyzeAgentSessionParams,
): Promise<AnalyzeAgentSessionResult> {
  const sample = sampleTranscript(p.transcript.slice(0, TRANSCRIPT_MAX_CHARS));
  if (sample.trim().length === 0) {
    return { learnings_found: 0, proposed: 0, updated: 0, skipped: 0 };
  }

  const domainLabel = p.meta.domains.length > 0 ? p.meta.domains.join(", ") : "(none declared)";
  const prompt = [
    `You are curating durable knowledge for the business domain(s): ${domainLabel}.`,
    `Below is a transcript sample of a coding-agent session (${p.meta.agent}).`,
    "Extract ONLY durable, reusable learnings that a HUMAN explicitly taught, corrected,",
    "or confirmed during the session — rules, conventions, gotchas, or facts that future",
    "sessions in these domains must know. Write each learning in the language the human",
    "used. Do NOT extract: task-specific details, one-off values, restatements of what",
    "the agent already knew, or anything the human did not sanction. When in doubt, leave",
    "it out — an empty list is the correct answer for a routine session.",
    "",
    "Transcript sample:",
    sample,
  ].join("\n");

  const result = await invoke<z.infer<typeof DistillationSchema>>(
    {
      flow: "extract",
      tenant_id: p.tenant_id,
      user_turns: [{ role: "user", content: prompt }],
      schema: DistillationSchema,
    },
    p.db,
  );

  const learnings = result.object?.learnings ?? [];
  const evidence_summary = [
    `agent=${p.meta.agent}`,
    p.meta.session_id ? `session=${p.meta.session_id}` : null,
    p.meta.repo ? `repo=${p.meta.repo}` : null,
    `domains=${domainLabel}`,
  ]
    .filter(Boolean)
    .join(" ");

  const counts = { proposed: 0, updated: 0, skipped: 0 };
  for (const learning of learnings) {
    const { action } = await proposeLearning({
      tenant_id: p.tenant_id,
      title: learning.title,
      body: learning.body,
      pitfalls: learning.pitfalls,
      domains: p.meta.domains,
      confidence: learning.confidence,
      evidence_summary,
      db: p.db,
    });
    counts[action] += 1;
  }
  return { learnings_found: learnings.length, ...counts };
}
