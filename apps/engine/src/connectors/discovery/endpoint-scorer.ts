import type { DiscoveredEndpoint } from "./types.ts";

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

const K1 = 1.5;
const B = 0.75;

export interface EndpointScore {
  endpoint: DiscoveredEndpoint;
  score: number;
  reasons: string[];
}

interface FieldHit {
  readonly label: "summary" | "description" | "path" | "operation_id" | "parameter";
  readonly count: number;
}

interface EndpointDoc {
  readonly tokens: string[];
  readonly tf: Map<string, number>;
  readonly fields: Map<string, FieldHit[]>;
}

function tokenize(input: string): string[] {
  if (!input) return [];
  return input
    .toLowerCase()
    .split(/\W+/)
    .filter((tok) => tok.length > 0);
}

function tokenizeQuery(input: string): string[] {
  return tokenize(input).filter((t) => !STOP_WORDS.has(t));
}

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

  const meanDocLen = docs.reduce((s, d) => s + d.tokens.length, 0) / N;
  const safeMean = meanDocLen > 0 ? meanDocLen : 1;

  const df = new Map<string, number>();
  for (const tok of queryTokens) {
    if (df.has(tok)) continue;
    let count = 0;
    for (const d of docs) {
      if (d.tf.has(tok)) count++;
    }
    df.set(tok, count);
  }

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
