import { createHash } from "node:crypto";
import type { z } from "@hono/zod-openapi";
import {
  DistillationSchema,
  type LearningKind,
  TRANSCRIPT_MAX_CHARS,
} from "../api/agent-sessions.ts";
import type { Actor } from "../audit/actor.ts";
import type { Db } from "../db/client.ts";
import { DOMAIN_TAG_PREFIX } from "../knowledge/tags.ts";
import { invoke } from "../llm/core/invoke.ts";
import { referencesKeyMaterialPath, scrubString } from "../logging/scrub-secrets.ts";
import { upsertFromSignal } from "../skill-candidates/service.ts";
import type { PatternSignal, SkillCandidateConfidence } from "../skill-candidates/types.ts";

const SAMPLE_HEAD_CHARS = 4_000;
const SAMPLE_TAIL_CHARS = 24_000;
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
  kind: LearningKind;
  actor: Actor | null;
  confidence: SkillCandidateConfidence;
  evidence_summary: string;
  db: Db;
}

export function learningFingerprint(domains: string[], title: string, kind: LearningKind): string {
  const normalizedTitle = title.toLowerCase().replace(/\s+/g, " ").trim();
  const domainKey = [...domains].sort().join(",");
  return createHash("sha256")
    .update(`${learningPattern(kind)}:${domainKey}:${normalizedTitle}`)
    .digest("hex");
}

export function learningPattern(kind: LearningKind): "session_learning" | "knowledge_learning" {
  return kind === "fact" ? "knowledge_learning" : "session_learning";
}

function domainTags(domains: string[]): string[] {
  return domains.map((d) => `${DOMAIN_TAG_PREFIX}${d}`);
}

export interface LearningText {
  title: string;
  body: string;
  pitfalls: string[];
}

export type RedactedLearning = { kind: "dropped" } | ({ kind: "kept" } & LearningText);

export function redactLearning(learning: LearningText): RedactedLearning {
  const texts = [learning.title, learning.body, ...learning.pitfalls];
  if (texts.some(referencesKeyMaterialPath)) return { kind: "dropped" };
  return {
    kind: "kept",
    title: scrubString(learning.title),
    body: scrubString(learning.body),
    pitfalls: learning.pitfalls.map(scrubString),
  };
}

export type ProposeLearningAction = "proposed" | "updated" | "skipped" | "dropped";

export async function proposeLearning(
  p: ProposeLearningParams,
): Promise<{ action: ProposeLearningAction; candidate_id: string | null }> {
  const redacted = redactLearning({ title: p.title, body: p.body, pitfalls: p.pitfalls ?? [] });
  if (redacted.kind === "dropped") return { action: "dropped", candidate_id: null };
  const signal: PatternSignal = {
    pattern_kind: learningPattern(p.kind),
    scope: "global",
    title: redacted.title,
    body: redacted.body,
    examples: [],
    best_practices: [],
    pitfalls: redacted.pitfalls,
    doc_refs: [],
    fingerprint: learningFingerprint(p.domains, redacted.title, p.kind),
    confidence: p.confidence,
    tags: domainTags(p.domains),
    proposer: p.actor,
    evidence: [
      { evidence_type: "agent_session", summary: scrubString(p.evidence_summary).slice(0, 2_000) },
    ],
  };
  const result = await upsertFromSignal(p.tenant_id, signal, p.db);
  if (result.action === "recorded")
    throw new Error("a session learning is a proposal, never drafting context");
  return { action: result.action, candidate_id: result.candidate_id };
}

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
  actor: Actor | null;
  db: Db;
}

export interface AnalyzeAgentSessionResult {
  learnings_found: number;
  proposed: number;
  updated: number;
  skipped: number;
  dropped: number;
}

export async function analyzeAgentSession(
  p: AnalyzeAgentSessionParams,
): Promise<AnalyzeAgentSessionResult> {
  const sample = scrubString(
    sampleTranscript(scrubString(p.transcript.slice(0, TRANSCRIPT_MAX_CHARS))),
  );
  if (sample.trim().length === 0) {
    return { learnings_found: 0, proposed: 0, updated: 0, skipped: 0, dropped: 0 };
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
    "Classify each learning: kind=practice when it says HOW to work (a rule, convention,",
    "gotcha) and kind=fact when it says WHAT is true in the domain (a name, number, owner,",
    "address, policy). Practices become skills; facts become part of the domain knowledge.",
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

  const counts = { proposed: 0, updated: 0, skipped: 0, dropped: 0 };
  for (const learning of learnings) {
    const { action } = await proposeLearning({
      tenant_id: p.tenant_id,
      title: learning.title,
      body: learning.body,
      pitfalls: learning.pitfalls,
      domains: p.meta.domains,
      kind: learning.kind,
      actor: p.actor,
      confidence: learning.confidence,
      evidence_summary,
      db: p.db,
    });
    counts[action] += 1;
  }
  return { learnings_found: learnings.length, ...counts };
}
