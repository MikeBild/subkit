import type { SkillExamplesBlob } from "./types.ts";

const listOrEmpty = (value: unknown): string[] => (Array.isArray(value) ? value : []);

export function skillExamplesFromBlob(blob: unknown): Required<SkillExamplesBlob> {
  if (Array.isArray(blob))
    return { examples: blob, best_practices: [], pitfalls: [], doc_refs: [] };
  const fields = (blob && typeof blob === "object" ? blob : {}) as SkillExamplesBlob;
  return {
    examples: listOrEmpty(fields.examples),
    best_practices: listOrEmpty(fields.best_practices),
    pitfalls: listOrEmpty(fields.pitfalls),
    doc_refs: listOrEmpty(fields.doc_refs),
  };
}
