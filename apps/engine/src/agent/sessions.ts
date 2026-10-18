import { createHash } from "node:crypto";
import type { z } from "@hono/zod-openapi";
import {
  DistillationSchema,
  LEARNING_EVIDENCE_MAX_CHARS,
  type LearningKind,
  TRANSCRIPT_MAX_CHARS,
} from "../api/agent-sessions.ts";
import type { Actor } from "../audit/actor.ts";
import type { Db } from "../db/client.ts";
import { createSessionIntakeItem, DOMAIN_TAG_PREFIX } from "../knowledge/index.ts";
import { invoke } from "../llm/core/invoke.ts";
import { referencesKeyMaterialPath, scrubString } from "../logging/scrub-secrets.ts";

const SAMPLE_HEAD_CHARS = 4_000;
const SAMPLE_TAIL_CHARS = 24_000;
export interface AgentSessionMeta {
  agent: string;
  session_id?: string;
  repo?: string;
  domains: string[];
}

export interface CollectSessionLearningParams {
  tenant_id: string;
  title: string;
  body: string;
  pitfalls?: string[];
  kind: LearningKind;
  actor: Actor | null;
  session: { agent: string; session_id: string; repo?: string | undefined; domains: string[] };
  evidence_excerpt: string;
  target?: LearningTarget | undefined;
  db: Db;
}

export type LearningTarget =
  | { scope: "global" }
  | { scope: "connector"; connector_id: string }
  | { scope: "workflow"; workflow_id: string };

export function learningTargetOf(context: {
  connector_id: string | null;
  workflow_id: string | null;
}): LearningTarget {
  if (context.workflow_id) return { scope: "workflow", workflow_id: context.workflow_id };
  if (context.connector_id) return { scope: "connector", connector_id: context.connector_id };
  return { scope: "global" };
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

export function learningBody(learning: Pick<LearningText, "body" | "pitfalls">): string {
  if (learning.pitfalls.length === 0) return learning.body;
  return [learning.body.trimEnd(), "", "Pitfalls:", ...learning.pitfalls.map((p) => `- ${p}`)].join(
    "\n",
  );
}

export type CollectSessionLearningOutcome =
  | "collected"
  | "evidence_appended"
  | "replayed"
  | "dropped";

export interface CollectSessionLearningResult {
  outcome: CollectSessionLearningOutcome;
  intake_item_id: string | null;
}

const COLLECT_OUTCOME = {
  created: "collected",
  evidence_appended: "evidence_appended",
  replayed: "replayed",
} as const;

export async function collectSessionLearning(
  p: CollectSessionLearningParams,
): Promise<CollectSessionLearningResult> {
  const redacted = redactLearning({ title: p.title, body: p.body, pitfalls: p.pitfalls ?? [] });
  if (redacted.kind === "dropped" || referencesKeyMaterialPath(p.evidence_excerpt))
    return { outcome: "dropped", intake_item_id: null };
  const result = await createSessionIntakeItem(
    {
      tenant_id: p.tenant_id,
      actor: p.actor,
      session: {
        agent: p.session.agent,
        session_id: p.session.session_id,
        repo: p.session.repo ?? null,
        domains: p.session.domains,
        evidence_excerpt: scrubString(p.evidence_excerpt).slice(0, 2_000),
      },
      title: redacted.title,
      body: learningBody(redacted),
      captured_at: new Date().toISOString(),
      learning: {
        kind: p.kind,
        ...(p.target ?? { scope: "global" }),
        tags: p.session.domains.map((domain) => `${DOMAIN_TAG_PREFIX}${domain}`),
      },
    },
    p.db,
  );
  return { outcome: COLLECT_OUTCOME[result.outcome], intake_item_id: result.item.id };
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
  collected: number;
  evidence_appended: number;
  replayed: number;
  dropped: number;
  not_collected: number;
}

export function transcriptSessionId(transcript: string): string {
  return `transcript-${createHash("sha256").update(transcript).digest("hex").slice(0, 32)}`;
}

export async function analyzeAgentSession(
  p: AnalyzeAgentSessionParams,
): Promise<AnalyzeAgentSessionResult> {
  const counts: AnalyzeAgentSessionResult = {
    learnings_found: 0,
    collected: 0,
    evidence_appended: 0,
    replayed: 0,
    dropped: 0,
    not_collected: 0,
  };
  const scrubbed = scrubString(p.transcript.slice(0, TRANSCRIPT_MAX_CHARS));
  const sample = scrubString(sampleTranscript(scrubbed));
  if (sample.trim().length === 0) return counts;

  const domainLabel = p.meta.domains.length > 0 ? p.meta.domains.join(", ") : "(none declared)";
  const prompt = [
    `You are collecting candidate knowledge for the business domain(s): ${domainLabel}.`,
    `Below is a transcript sample of a coding-agent session (${p.meta.agent}).`,
    "Extract ONLY durable, reusable learnings that a HUMAN explicitly taught, corrected,",
    "or confirmed during the session — rules, conventions, gotchas, or facts that future",
    "sessions in these domains must know. Write each learning in the language the human",
    "used. Do NOT extract: task-specific details, one-off values, restatements of what",
    "the agent already knew, or anything the human did not sanction. When in doubt, leave",
    "it out — an empty list is the correct answer for a routine session.",
    "Classify each learning: kind=practice when it says HOW to work (a rule, convention,",
    "gotcha); kind=fact when it says WHAT is true in the domain (a name, number, owner,",
    "address, policy); kind=event when it reports a status or something that happened",
    "(a release, a deployment, a run result, a removal); kind=secret when it names",
    "credentials, keys, tokens or where they are stored. Events and secrets are discarded.",
    "Everything else is collected for a person to review; nothing becomes a skill or",
    "knowledge until that person confirms it. Quote what the human said as evidence.",
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
  counts.learnings_found = learnings.length;
  const session = {
    agent: p.meta.agent,
    session_id: p.meta.session_id ?? transcriptSessionId(scrubbed),
    ...(p.meta.repo ? { repo: p.meta.repo } : {}),
    domains: p.meta.domains,
  };
  const provenance = [
    `agent=${p.meta.agent}`,
    `session=${session.session_id}`,
    p.meta.repo ? `repo=${p.meta.repo}` : null,
    `domains=${domainLabel}`,
  ]
    .filter(Boolean)
    .join(" ");

  for (const learning of learnings) {
    if (learning.kind === "event" || learning.kind === "secret") {
      counts.not_collected += 1;
      continue;
    }
    const { outcome } = await collectSessionLearning({
      tenant_id: p.tenant_id,
      title: learning.title,
      body: learning.body,
      pitfalls: learning.pitfalls,
      kind: learning.kind,
      actor: p.actor,
      session,
      evidence_excerpt: learning.evidence
        ? learning.evidence.slice(0, LEARNING_EVIDENCE_MAX_CHARS)
        : provenance,
      db: p.db,
    });
    counts[outcome] += 1;
  }
  return counts;
}
