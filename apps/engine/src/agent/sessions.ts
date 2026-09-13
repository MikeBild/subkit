// Coding-agent session capture: distill a session transcript into
// learning candidates, and propose explicit learnings from the
// `save_learning` tool. Every path lands as a `session_learning`
// Skill Candidate with `status: "proposed"` — activation stays behind
// the human approve gate (`sk learnings review` / approve routes).

import { createHash } from "node:crypto";

import { z } from "@hono/zod-openapi";

import type { Db } from "../db/client.ts";
import { invoke } from "../llm/core/invoke.ts";
import { upsertFromSignal } from "../skill-candidates/service.ts";
import type { PatternSignal, SkillCandidateConfidence } from "../skill-candidates/types.ts";
import { DOMAIN_TAG_PREFIX } from "./briefing.ts";

// Transcript sample handed to the extract flow: corrections and taught
// rules skew late in a session, so keep the head for context and spend
// most of the budget on the tail (~7k tokens total at 4 chars/token).
const SAMPLE_HEAD_CHARS = 4_000;
const SAMPLE_TAIL_CHARS = 24_000;
/** Hard cap a caller may submit; the route enforces it too. */
export const TRANSCRIPT_MAX_CHARS = 1_000_000;
export const MAX_LEARNINGS_PER_SESSION = 8;

export interface AgentSessionMeta {
  /** Which agent produced the session, e.g. "claude-code", "codex". */
  agent: string;
  session_id?: string;
  repo?: string;
  /** Domain slugs (without `domain:` prefix) the session grounded on. */
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

/** Deterministic dedup identity: the same rule re-taught in a later
 *  session must hit the same candidate (evidence accrues, no duplicate
 *  queue entries). Title is normalized so cosmetic rewording still dedups. */
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

/** Single chokepoint that turns a learning into a proposed candidate —
 *  used by the `save_learning` tool and the transcript distillation. */
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

// ---------------------------------------------------------------------------
// Transcript distillation
// ---------------------------------------------------------------------------

const LearningSchema = z.object({
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(4_000),
  pitfalls: z.array(z.string().min(1).max(500)).max(5).default([]),
  confidence: z.enum(["low", "medium", "high"]),
});

const DistillationSchema = z.object({
  learnings: z.array(LearningSchema).max(MAX_LEARNINGS_PER_SESSION),
});

/** Pull human-readable text out of one transcript line. Claude Code
 *  session transcripts are JSONL with nested message shapes; Codex
 *  rollouts differ; plain text passes through. Best-effort: a line we
 *  cannot parse is used verbatim. */
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

/** Head + tail sample of the readable transcript text, budget-capped. */
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

/**
 * Distill a coding-agent session transcript into learning candidates.
 * The prompt asks only for DURABLE, human-taught rules — task-specific
 * details and things already known must yield an empty list, so a routine
 * session produces no queue noise.
 */
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
