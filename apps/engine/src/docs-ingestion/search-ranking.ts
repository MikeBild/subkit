export type SearchHitMatchType = "operation" | "auth" | "schema" | "general";

interface SearchHitCandidate {
  id: string;
  document_id: string;
  title: string | null;
  path: string | null;
  content: string;
  snippet: string;
  rank: number;
  fetched_at: string | null;
}

interface RankedSearchHit {
  id: string;
  document_id: string;
  title: string | null;
  path: string | null;
  snippet: string;
  rank: number;
  match_type: SearchHitMatchType;
  fetched_at: string | null;
}

type SearchIntent = SearchHitMatchType;

const AUTH_TERMS = new Set([
  "apikey",
  "api-key",
  "api_key",
  "auth",
  "authorization",
  "basic",
  "bearer",
  "client_credentials",
  "oauth",
  "oauth2",
  "pkce",
  "scope",
  "secret",
  "token",
]);

const SCHEMA_TERMS = new Set([
  "attribute",
  "body",
  "field",
  "fields",
  "parameter",
  "parameters",
  "payload",
  "properties",
  "property",
  "request",
  "response",
  "schema",
  "type",
  "types",
]);

const OPERATION_TERMS = new Set([
  "create",
  "delete",
  "fetch",
  "get",
  "list",
  "patch",
  "post",
  "put",
  "read",
  "search",
  "update",
]);

function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9/_-]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);
}

function countMatches(haystack: string, tokens: string[]): number {
  let score = 0;
  for (const token of tokens) {
    if (!haystack.includes(token)) continue;
    score += token.length >= 4 ? 2 : 1;
  }
  return score;
}

function countKeywordMatches(tokens: string[], keywords: ReadonlySet<string>): number {
  return tokens.reduce((count, token) => count + (keywords.has(token) ? 1 : 0), 0);
}

function classifyIntent(tokens: string[]): SearchIntent {
  const authMatches = countKeywordMatches(tokens, AUTH_TERMS);
  const schemaMatches = countKeywordMatches(tokens, SCHEMA_TERMS);
  const operationMatches =
    countKeywordMatches(tokens, OPERATION_TERMS) +
    tokens.filter((token) => token.includes("/")).length;

  if (authMatches >= schemaMatches && authMatches >= operationMatches && authMatches > 0) {
    return "auth";
  }
  if (schemaMatches >= operationMatches && schemaMatches > 0) {
    return "schema";
  }
  if (operationMatches > 0) return "operation";
  return "general";
}

function detectOperationSignal(text: string, tokens: string[]): number {
  const termMatches = countKeywordMatches(tokens, OPERATION_TERMS);
  const pathLikeTokens = tokens.filter((token) => token.includes("/"));
  return termMatches * 3 + countMatches(text, pathLikeTokens) * 3 + countMatches(text, tokens);
}

function detectAuthSignal(text: string, tokens: string[]): number {
  const authTokens = tokens.filter((token) => AUTH_TERMS.has(token));
  const securityBonus =
    text.includes("authorization") ||
    text.includes("bearer") ||
    text.includes("oauth") ||
    text.includes("security")
      ? 2
      : 0;
  return countMatches(text, authTokens) * 3 + securityBonus;
}

function detectSchemaSignal(text: string, tokens: string[]): number {
  const schemaTokens = tokens.filter((token) => SCHEMA_TERMS.has(token));
  const structureBonus =
    text.includes("schema") ||
    text.includes("property") ||
    text.includes("response") ||
    text.includes("request body")
      ? 2
      : 0;
  return countMatches(text, schemaTokens) * 3 + structureBonus;
}

function classifyMatchType(
  intent: SearchIntent,
  signals: Record<SearchHitMatchType, number>,
): SearchHitMatchType {
  if (intent !== "general" && signals[intent] > 0) return intent;
  if (
    signals.operation >= signals.auth &&
    signals.operation >= signals.schema &&
    signals.operation > 0
  ) {
    return "operation";
  }
  if (signals.auth >= signals.schema && signals.auth > 0) return "auth";
  if (signals.schema > 0) return "schema";
  return "general";
}

export function rerankSearchHits(
  query: string,
  candidates: SearchHitCandidate[],
  limit: number,
): RankedSearchHit[] {
  const tokens = tokenizeQuery(query);
  const intent = classifyIntent(tokens);

  return candidates
    .map((candidate) => {
      const title = candidate.title?.toLowerCase() ?? "";
      const path = candidate.path?.toLowerCase() ?? "";
      const content = candidate.content.toLowerCase();

      const operationSignal =
        detectOperationSignal(title, tokens) * 3 +
        detectOperationSignal(path, tokens) * 4 +
        detectOperationSignal(content, tokens);
      const authSignal =
        detectAuthSignal(title, tokens) * 2 +
        detectAuthSignal(path, tokens) +
        detectAuthSignal(content, tokens);
      const schemaSignal =
        detectSchemaSignal(title, tokens) * 2 +
        detectSchemaSignal(path, tokens) +
        detectSchemaSignal(content, tokens);
      const generalSignal =
        countMatches(title, tokens) * 2 +
        countMatches(path, tokens) * 3 +
        countMatches(content, tokens);

      const signals: Record<SearchHitMatchType, number> = {
        operation: operationSignal,
        auth: authSignal,
        schema: schemaSignal,
        general: generalSignal,
      };

      const match_type = classifyMatchType(intent, signals);
      const intentBoost = intent !== "general" && match_type === intent ? 8 : 0;
      const boostedRank = candidate.rank + generalSignal + signals[match_type] + intentBoost;

      return {
        id: candidate.id,
        document_id: candidate.document_id,
        title: candidate.title,
        path: candidate.path,
        snippet: candidate.snippet,
        rank: Number(boostedRank.toFixed(3)),
        match_type,
        fetched_at: candidate.fetched_at,
      };
    })
    .sort((a, b) => b.rank - a.rank)
    .slice(0, limit);
}
