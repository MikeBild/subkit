// Keyword-scored endpoint suggestions.
//
// Discovery refinement: the operator's most recent message often
// signals which of the (sometimes hundreds of) discovered endpoints they
// actually care about. A BM25-lite score over `summary + description +
// path + operation_id + parameters[].name` lets the conversation tool
// surface a `suggested_endpoints` shortlist BEFORE the agent re-reads the
// full index. Without the shortlist, the LLM either guesses
// (`/account` against DigitalOcean, the original session-00b93a52 bug)
// or burns tokens scanning the entire endpoint list every turn.
//
// Scoring is deterministic, dependency-free, and runs on the conversation
// thread — no LLM call. BM25 parameters: k1 = 1.5, b = 0.75 (standard
// defaults). Mean document length is computed across the supplied
// endpoint set so the bias adapts to the corpus.

import type { DiscoveredEndpoint } from "./types.ts";

/** Stop words dropped from the operator's query before scoring. Kept
 *  intentionally small — anything beyond articles, common prepositions,
 *  and meta verbs would risk filtering meaningful tokens (`page`,
 *  `cursor`, `filter`). */
const STOP_WORDS: ReadonlySet<string> = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "for",
  "with",
  "from",
  "get",
  "list",
  "show",
  "all",
  "me",
  "my",
  "our",
]);

/** BM25 term-frequency saturation parameter. */
const K1 = 1.5;
/** BM25 length-normalisation parameter. */
const B = 0.75;

export interface EndpointScore {
  endpoint: DiscoveredEndpoint;
  score: number;
  /** Human-readable list of which query token matched which endpoint
   *  field, e.g. `["matched 'droplets' in path"]`. The agent surfaces
   *  these so the operator can see *why* a suggestion ranked high. */
  reasons: string[];
}

interface FieldHit {
  /** Field label used in the human-readable reason string. */
  readonly label: "summary" | "description" | "path" | "operation_id" | "parameter";
  /** Token frequency contribution from this field. */
  readonly count: number;
}

interface EndpointDoc {
  /** Tokens flattened from every searchable field on the endpoint. Used
   *  for length-normalisation. */
  readonly tokens: string[];
  /** Raw token frequencies — keys = lowercase terms, values = counts. */
  readonly tf: Map<string, number>;
  /** Per-field hit map keyed by token. Empty arrays are dropped. */
  readonly fields: Map<string, FieldHit[]>;
}

function tokenize(input: string): string[] {
  if (!input) return [];
  return input
    .toLowerCase()
    .split(/\W+/)
    .filter((tok) => tok.length > 0);
}

/** Tokenise + drop stop-words. Used both for the operator's query and
 *  for ranking comparisons. */
function tokenizeQuery(input: string): string[] {
  return tokenize(input).filter((t) => !STOP_WORDS.has(t));
}

/** Build the per-endpoint document used by the BM25 scorer. The
 *  document tracks both flattened tokens (for length normalisation)
 *  and per-field hits (for the human-readable reason strings). */
function buildDoc(ep: DiscoveredEndpoint): EndpointDoc {
  const fields: Array<{ label: FieldHit["label"]; text: string }> = [
    { label: "summary", text: ep.summary ?? "" },
    { label: "description", text: ep.description ?? "" },
    { label: "path", text: ep.path },
    { label: "operation_id", text: ep.operation_id ?? "" },
    { label: "parameter", text: ep.params.map((p) => p.name).join(" ") },
  ];

  const tokens: string[] = [];
  const tf = new Map<string, number>();
  const perField = new Map<string, FieldHit[]>();

  for (const f of fields) {
    const fieldTokens = tokenize(f.text);
    if (fieldTokens.length === 0) continue;
    const localCounts = new Map<string, number>();
    for (const tok of fieldTokens) {
      tokens.push(tok);
      tf.set(tok, (tf.get(tok) ?? 0) + 1);
      localCounts.set(tok, (localCounts.get(tok) ?? 0) + 1);
    }
    for (const [tok, count] of localCounts) {
      const arr = perField.get(tok) ?? [];
      arr.push({ label: f.label, count });
      perField.set(tok, arr);
    }
  }

  return { tokens, tf, fields: perField };
}

/**
 * Score every endpoint against the operator's query and return the top
 * `topK` matches with non-zero scores, descending by score. Stable
 * ordering: ties are broken by the original endpoint index so callers
 * see deterministic output across runs. Returns `[]` when the query is
 * empty or contains only stop-words.
 */
export function scoreEndpoints(
  query: string,
  endpoints: readonly DiscoveredEndpoint[],
  topK: number,
): EndpointScore[] {
  const queryTokens = tokenizeQuery(query);
  if (queryTokens.length === 0) return [];
  if (endpoints.length === 0) return [];

  const docs = endpoints.map(buildDoc);
  const N = docs.length;

  // Length normalisation: average doc length across the supplied corpus.
  const meanDocLen = docs.reduce((s, d) => s + d.tokens.length, 0) / N;
  const safeMean = meanDocLen > 0 ? meanDocLen : 1;

  // Document frequencies — how many docs contain each unique query
  // token. Used to compute IDF.
  const df = new Map<string, number>();
  for (const tok of queryTokens) {
    if (df.has(tok)) continue;
    let count = 0;
    for (const d of docs) {
      if (d.tf.has(tok)) count++;
    }
    df.set(tok, count);
  }

  // BM25 IDF, the smoothed variant: ln((N - df + 0.5) / (df + 0.5) + 1).
  const idf = new Map<string, number>();
  for (const [tok, n] of df) {
    idf.set(tok, Math.log((N - n + 0.5) / (n + 0.5) + 1));
  }

  const scored: EndpointScore[] = endpoints.map((ep, idx) => {
    const doc = docs[idx]!;
    let score = 0;
    const reasons: string[] = [];
    const seenReasons = new Set<string>();
    const docLen = doc.tokens.length;
    const lengthNorm = 1 - B + B * (docLen / safeMean);

    for (const tok of queryTokens) {
      const tf = doc.tf.get(tok) ?? 0;
      if (tf === 0) continue;
      const termIdf = idf.get(tok) ?? 0;
      const numerator = tf * (K1 + 1);
      const denominator = tf + K1 * lengthNorm;
      score += termIdf * (numerator / denominator);

      const hits = doc.fields.get(tok);
      if (hits) {
        for (const hit of hits) {
          const reason = `matched '${tok}' in ${hit.label}`;
          if (!seenReasons.has(reason)) {
            seenReasons.add(reason);
            reasons.push(reason);
          }
        }
      }
    }

    return { endpoint: ep, score, reasons };
  });

  // Stable sort: descending by score, ties preserve original input
  // order. `Array.prototype.sort` is engine-defined, so we attach the
  // original index ourselves and break ties on it.
  const indexed = scored.map((s, i) => ({ s, i }));
  indexed.sort((a, b) => {
    if (b.s.score !== a.s.score) return b.s.score - a.s.score;
    return a.i - b.i;
  });

  const result: EndpointScore[] = [];
  for (const { s } of indexed) {
    if (s.score <= 0) break;
    result.push(s);
    if (result.length >= topK) break;
  }
  return result;
}
