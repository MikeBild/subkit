import { and, eq, inArray } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { connectorDocumentChunks } from "../db/schema/connector_docs.ts";
import { knowledgeChunks } from "../db/schema/knowledge_sources.ts";
import { invoke } from "../llm/core/invoke.ts";
import { logger } from "../logging/logger.ts";
import type { Citation } from "./citations.ts";
import { isProductDocId } from "./tools/product-docs.ts";

interface SourceFaithfulParams {
  text: string;
  citations: ReadonlyArray<Citation>;
  tenant_id: string;
  db: Executor;
  signal?: AbortSignal;
}

interface SourceFaithfulVerdict {
  verdict: "pass" | "fail";
  confidence: number;
  reason: string;
  checks: {
    ids_resolve: boolean;
    quotes_grounded: boolean;
    paraphrase_faithful?: boolean;
  };
  detail?: string;
}

export function extractQuotedSpans(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
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

function normalise(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

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
    if (needle.length > longestExcerpt) continue;
    if (!excerpts.some((e) => e.includes(needle))) ungrounded.push(span);
  }
  return ungrounded;
}

const CITATION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  const productDocUnresolved = Array.from(
    new Set(citations.filter((c) => c.source_type === "product_doc").map((c) => c.id)),
  ).filter((id) => !isProductDocId(id));

  const knowledgeResolved = new Set(knowledgeRows.map((r) => r.id));
  const docResolved = new Set(docRows.map((r) => r.id));
  return [
    ...kc.malformed,
    ...kc.queryable.filter((id) => !knowledgeResolved.has(id)),
    ...dc.malformed,
    ...dc.queryable.filter((id) => !docResolved.has(id)),
    ...productDocUnresolved,
  ];
}

export async function keepResolvableCitations(
  citations: ReadonlyArray<Citation>,
  tenant_id: string,
  db: Executor,
): Promise<Citation[]> {
  if (citations.length === 0) return [];
  const unresolved = new Set(await findUnresolvedIds(citations, tenant_id, db));
  return citations.filter((c) => !unresolved.has(c.id));
}

const FaithfulnessJudgeSummary = {
  PASS: "faithful",
  DRIFT: "drift",
} as const;

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

export async function checkSourceFaithful(
  params: SourceFaithfulParams,
): Promise<SourceFaithfulVerdict> {
  const { text, citations, tenant_id, db, signal } = params;

  if (citations.length === 0) {
    return {
      verdict: "pass",
      confidence: 1,
      reason: "no citation envelope — source_faithful is a no-op",
      checks: { ids_resolve: true, quotes_grounded: true },
    };
  }

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
