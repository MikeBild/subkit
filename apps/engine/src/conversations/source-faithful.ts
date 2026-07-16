// source_faithful — anti-drift check.
//
// The "prove-after" half of the grounding contract attaches a
// citation envelope to every answer that grounded itself in a source.
// This module closes the remaining gap: the prose must stay FAITHFUL to
// the sources it cited. A citation envelope proves an answer *touched* a
// source; it does not prove the prose actually says what the source says.
//
// The check runs ONLY when a citation envelope is present — a turn with
// no citations is the prove-BEFORE gate's responsibility (factual claim
// with no source → cannot_help), not this one. With an envelope, it
// answers two questions:
//
//   1. RESOLVE (deterministic, DB): does every cited id actually exist
//      for this tenant? A cited knowledge_chunk that resolves to no row
//      is a fabricated provenance handle — the worst kind of drift,
//      because the envelope *looks* auditable.
//   2. QUOTE FIDELITY (deterministic, in-memory): every span the prose
//      puts in quotation marks — signalling a verbatim quotation from a
//      source — must appear in at least one cited excerpt. A quoted span
//      grounded in none of the cited excerpts is a fabricated quote.
//
// Anything beyond those two — free-text paraphrase faithfulness that no
// structural predicate can decide — escalates to the format-aware judge
// (preview-judge.ts), and ONLY then. The judge is the
// escalation, never the first line: deterministic checks are cheaper,
// faster, and not themselves a hallucination risk.
//
// A failure here is consumed by the loop exactly like a low-confidence
// critic verdict: it feeds the existing `confidence < 0.6 → ask_user`
// abstention so the turn abstains / rewrites to cannot_help instead of
// emitting drifted prose.

import { and, eq, inArray } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { connectorDocumentChunks } from "../db/schema/connector_docs.ts";
import { knowledgeChunks } from "../db/schema/knowledge_sources.ts";
import { invoke } from "../llm/core/invoke.ts";
import { logger } from "../logging/logger.ts";
import type { Citation } from "./citations.ts";

export interface SourceFaithfulParams {
  /** The assistant's final visible prose. */
  text: string;
  /** The citation envelope harvested from this turn. */
  citations: ReadonlyArray<Citation>;
  tenant_id: string;
  db: Executor;
  /** Turn/pipeline abort signal — threaded into the judge's invoke(). */
  signal?: AbortSignal;
  /** Tenant default LLM; the judge rides invoke() so this is informational. */
}

export interface SourceFaithfulVerdict {
  verdict: "pass" | "fail";
  /** 0..1 — below 0.6 the loop surfaces the abstention follow-up. */
  confidence: number;
  reason: string;
  /** Per-question outcomes for telemetry / audit. */
  checks: {
    ids_resolve: boolean;
    quotes_grounded: boolean;
    /** undefined when the judge was not reached (det. checks already failed,
     *  no free text to judge, or judge unavailable). */
    paraphrase_faithful?: boolean;
  };
  /** Concrete drift evidence for the operator-facing abstention prompt. */
  detail?: string;
}

/**
 * Extract quoted spans the prose presents as verbatim quotations from a
 * source. Only straight and curly double quotes count — single quotes
 * collide with apostrophes/contractions and would be noise. Whitespace
 * is normalised and the span lower-cased so the comparison against an
 * excerpt is robust to re-wrapping; spans shorter than 8 chars are
 * dropped (too short to be a meaningful, checkable quotation).
 */
export function extractQuotedSpans(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Straight "..." and curly “...” pairs, non-greedy, no embedded newline.
  const re = /(?:"([^"\n]+)"|“([^”\n]+)”)/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
  while ((m = re.exec(text)) !== null) {
    const raw = (m[1] ?? m[2] ?? "").replace(/\s+/g, " ").trim();
    if (raw.length < 8) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  return out;
}

/** Whitespace-normalised, lower-cased haystack for substring matching. */
function normalise(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Deterministic quote-fidelity check. A quoted span is grounded when its
 * normalised form is a substring of any cited excerpt's normalised form.
 * Returns the quoted spans that appear in NO cited excerpt.
 *
 * Excerpts are clipped (capped at 200 chars), so a quote can be
 * legitimately grounded yet fall outside the excerpt window — to avoid a
 * false drift signal, a span LONGER than the longest excerpt is treated
 * as unverifiable here (deferred to the judge), not failed.
 */
export function findUngroundedQuotes(text: string, citations: ReadonlyArray<Citation>): string[] {
  const excerpts = citations
    .map((c) => c.excerpt)
    .filter((e): e is string => typeof e === "string" && e.length > 0)
    .map(normalise);
  if (excerpts.length === 0) return [];
  const longestExcerpt = excerpts.reduce((n, e) => Math.max(n, e.length), 0);
  const ungrounded: string[] = [];
  for (const span of extractQuotedSpans(text)) {
    const needle = normalise(span);
    // Unverifiable against a clipped excerpt → defer, don't fail.
    if (needle.length > longestExcerpt) continue;
    if (!excerpts.some((e) => e.includes(needle))) ungrounded.push(span);
  }
  return ungrounded;
}

/**
 * Deterministic resolution check. Every cited id must resolve to a row
 * owned by this tenant — knowledge_chunk ids against the knowledge chunks,
 * connector_doc ids against the connector-document chunks (each split out by
 * source_type and queried separately). Returns the cited ids that do NOT
 * resolve. Both queries are tenant-scoped (audit-invariant: tenant_id
 * predicate is present and visible), so a fabricated id of either kind is
 * caught by the anti-drift gate.
 */
const CITATION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Split cited ids into (malformed — never resolvable, and would make the
 *  inArray uuid cast throw) and (queryable UUIDs). */
function splitCitationIds(ids: string[]): { malformed: string[]; queryable: string[] } {
  const unique = Array.from(new Set(ids));
  return {
    malformed: unique.filter((id) => !CITATION_UUID.test(id)),
    queryable: unique.filter((id) => CITATION_UUID.test(id)),
  };
}

async function findUnresolvedIds(
  citations: ReadonlyArray<Citation>,
  tenant_id: string,
  db: Executor,
): Promise<string[]> {
  // EVERY harvested source_type MUST resolve against a real, tenant-scoped
  // table — a harvested-but-unqueried kind would let a fabricated citation
  // id pass the anti-drift gate unverified (a provenance hole).
  const kc = splitCitationIds(
    citations.filter((c) => c.source_type === "knowledge_chunk").map((c) => c.id),
  );
  const dc = splitCitationIds(
    citations.filter((c) => c.source_type === "connector_doc").map((c) => c.id),
  );

  const [knowledgeRows, docRows] = await Promise.all([
    kc.queryable.length === 0
      ? Promise.resolve([] as { id: string }[])
      : db
          .select({ id: knowledgeChunks.id })
          .from(knowledgeChunks)
          .where(
            and(
              eq(knowledgeChunks.tenant_id, tenant_id),
              inArray(knowledgeChunks.id, kc.queryable),
            ),
          ),
    dc.queryable.length === 0
      ? Promise.resolve([] as { id: string }[])
      : db
          .select({ id: connectorDocumentChunks.id })
          .from(connectorDocumentChunks)
          .where(
            and(
              eq(connectorDocumentChunks.tenant_id, tenant_id),
              inArray(connectorDocumentChunks.id, dc.queryable),
            ),
          ),
  ]);

  const knowledgeResolved = new Set(knowledgeRows.map((r) => r.id));
  const docResolved = new Set(docRows.map((r) => r.id));
  return [
    ...kc.malformed,
    ...kc.queryable.filter((id) => !knowledgeResolved.has(id)),
    ...dc.malformed,
    ...dc.queryable.filter((id) => !docResolved.has(id)),
  ];
}

const FaithfulnessJudgeSummary = {
  PASS: "faithful",
  DRIFT: "drift",
} as const;

/**
 * Free-text faithfulness judge — the F4' escalation. Reached ONLY after
 * both deterministic checks pass and there is prose to judge. Asks the
 * tenant model whether the answer makes any factual claim NOT supported
 * by the cited excerpts. Never throws: an infra blip is `undefined`
 * (treated as a pass by the caller — the judge is an escalation, not a
 * gate that an outage can flip closed).
 */
async function judgeParaphraseFaithful(
  text: string,
  citations: ReadonlyArray<Citation>,
  tenant_id: string,
  db: Executor,
  signal: AbortSignal | undefined,
): Promise<{ faithful: boolean; reason: string } | undefined> {
  const sources = citations
    .map((c, i) => {
      const name = c.source_name ? ` (${c.source_name})` : "";
      const ex = c.excerpt ? `\n  excerpt: ${c.excerpt}` : "";
      return `[${i + 1}] ${c.source_type}:${c.id}${name}${ex}`;
    })
    .join("\n");
  const prompt = [
    "You verify that an assistant's answer stays FAITHFUL to the sources it cited.",
    "",
    "Cited sources (the ONLY evidence the answer is allowed to rest on):",
    sources,
    "",
    "Assistant answer:",
    '"""',
    text,
    '"""',
    "",
    "Decide whether the answer's factual claims are supported by the cited excerpts.",
    `Reply "${FaithfulnessJudgeSummary.PASS}" if every factual claim is supported by, or a faithful paraphrase of, the cited excerpts.`,
    `Reply "${FaithfulnessJudgeSummary.DRIFT}" if the answer asserts a fact the cited excerpts do not support (a value, name, count, or relationship that is absent from or contradicts the sources).`,
    "Meta/clarifying sentences (offers to help, questions, formatting) are not factual claims — ignore them.",
    "",
    `Return ONLY one word: ${FaithfulnessJudgeSummary.PASS} or ${FaithfulnessJudgeSummary.DRIFT}.`,
  ].join("\n");
  try {
    const result = await invoke(
      {
        flow: "judge",
        tenant_id,
        user_turns: [{ role: "user", content: prompt }],
        ...(signal ? { signal } : {}),
      },
      db,
    );
    const word = result.text.trim().toLowerCase();
    if (word.includes(FaithfulnessJudgeSummary.DRIFT)) {
      return {
        faithful: false,
        reason: "judge: answer asserts facts the cited sources do not support",
      };
    }
    if (word.includes(FaithfulnessJudgeSummary.PASS)) {
      return { faithful: true, reason: "judge: prose faithful to cited sources" };
    }
    // Unparseable verdict → unavailable, defer to caller default.
    return undefined;
  } catch (err) {
    logger.warn({
      module: "conversations",
      action: "source_faithful.judge_unavailable",
      msg: "faithfulness judge LLM call failed — skipping (treated as pass)",
      tenant_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Run the source_faithful anti-drift check.
 *
 * Skipped (returns a passing no-op) when there is no citation envelope —
 * that case belongs to the prove-before gate, not this one.
 *
 * Order: deterministic id-resolution → deterministic quote fidelity →
 * (only if both pass and free text remains) format-aware paraphrase
 * judge. The first deterministic failure short-circuits; the judge is a
 * pure escalation.
 */
export async function checkSourceFaithful(
  params: SourceFaithfulParams,
): Promise<SourceFaithfulVerdict> {
  const { text, citations, tenant_id, db, signal } = params;

  // No envelope → not this check's job. No-op pass.
  if (citations.length === 0) {
    return {
      verdict: "pass",
      confidence: 1,
      reason: "no citation envelope — source_faithful is a no-op",
      checks: { ids_resolve: true, quotes_grounded: true },
    };
  }

  // 1. Deterministic: every cited id must resolve for this tenant.
  const unresolved = await findUnresolvedIds(citations, tenant_id, db);
  if (unresolved.length > 0) {
    return {
      verdict: "fail",
      confidence: 0.2,
      reason: "cited source ids do not resolve — fabricated provenance",
      checks: { ids_resolve: false, quotes_grounded: false },
      detail: `unresolved cited ids: ${unresolved.slice(0, 3).join(", ")}`,
    };
  }

  // 2. Deterministic: every verbatim quote must appear in a cited excerpt.
  const ungroundedQuotes = findUngroundedQuotes(text, citations);
  if (ungroundedQuotes.length > 0) {
    return {
      verdict: "fail",
      confidence: 0.3,
      reason: "quoted text appears in none of the cited sources — fabricated quote",
      checks: { ids_resolve: true, quotes_grounded: false },
      detail: `ungrounded quote(s): ${ungroundedQuotes
        .slice(0, 2)
        .map((q) => `“${q.slice(0, 60)}”`)
        .join(", ")}`,
    };
  }

  // 3. Escalation: free-text paraphrase faithfulness the predicates can't
  //    decide. Only reached because both deterministic checks passed.
  //    Skip when there is no substantive prose to judge.
  if (text.trim().length < 8) {
    return {
      verdict: "pass",
      confidence: 1,
      reason: "deterministic checks passed; no prose to judge",
      checks: { ids_resolve: true, quotes_grounded: true },
    };
  }
  const judged = await judgeParaphraseFaithful(text, citations, tenant_id, db, signal);
  if (judged && !judged.faithful) {
    return {
      verdict: "fail",
      confidence: 0.4,
      reason: judged.reason,
      checks: { ids_resolve: true, quotes_grounded: true, paraphrase_faithful: false },
      detail: "the answer makes claims the cited sources do not support",
    };
  }
  return {
    verdict: "pass",
    confidence: 1,
    reason: judged
      ? judged.reason
      : "deterministic checks passed; judge unavailable (treated as pass)",
    checks: {
      ids_resolve: true,
      quotes_grounded: true,
      ...(judged ? { paraphrase_faithful: true } : {}),
    },
  };
}
