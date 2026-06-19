import { rerankSearchHits } from "../../src/docs-ingestion/search-ranking.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";

interface Input {
  query: string;
  candidates: Array<{
    id: string;
    document_id: string;
    title: string | null;
    path: string | null;
    content: string;
    snippet: string;
    rank: number;
  }>;
  expected_top_id: string;
  expected_match_type: "operation" | "auth" | "schema" | "general";
}

export function validate(fixture: FixtureRecord): ValidationResult {
  const input = fixture.input as Input;
  const [top] = rerankSearchHits(input.query, input.candidates, 1);
  if (!top) return { pass: false, reason: "reranker returned no hits" };
  if (top.id !== input.expected_top_id) {
    return {
      pass: false,
      reason: `expected top id '${input.expected_top_id}', got '${top.id}'`,
    };
  }
  if (top.match_type !== input.expected_match_type) {
    return {
      pass: false,
      reason: `expected match_type '${input.expected_match_type}', got '${top.match_type}'`,
    };
  }
  return { pass: true };
}
