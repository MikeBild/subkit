// One-shot quality fixer: bring intent_keywords on every recipe up to
// the lint contract enforced by `scripts/lint-recipes.ts`:
//
//   * length in [3, 7]
//   * lowercase
//   * no duplicate single-word keywords already in the title
//
// Strategy:
//   * Lowercase every keyword.
//   * Drop single-word keywords that are already in the title (the
//     title carries the same signal, no ranking lift from duplicating).
//   * Backfill to ≥3 by deriving phrases from the title + slug:
//       - lowercased title
//       - lowercased slug as space-separated phrase
//       - title with a leading verb stripped
//     dedupes against existing keywords.
//   * Cap at 7 by keeping the most distinctive (longest) entries.
//
// Idempotent — re-running on already-fixed recipes is a no-op.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const TEMPLATES_PATH = resolve(import.meta.dir, "..", "apps/engine/src/connectors/templates.json");

type Recipe = {
  slug: string;
  title: string;
  intent_keywords?: string[];
  [k: string]: unknown;
};

type Template = {
  slug: string;
  recipes?: Recipe[];
};

function normalize(kw: string): string {
  return kw.trim().toLowerCase();
}

function deriveCandidates(recipe: Recipe, templateSlug: string): string[] {
  const titleLower = recipe.title.toLowerCase();
  const slugWords = recipe.slug.replace(/-/g, " ");
  const templateWords = templateSlug.replace(/-/g, " ");
  const out = new Set<string>();
  out.add(titleLower);
  out.add(slugWords);
  // Title with leading verb stripped (e.g. "List Cognito users" → "cognito users").
  const verbMatch = titleLower.match(/^(list|get|create|update|delete|add|remove|set)\s+(.+)$/);
  if (verbMatch) {
    const verb = verbMatch[1] ?? "";
    const rest = verbMatch[2] ?? "";
    out.add(rest);
    if (verb === "list") {
      out.add(`all ${rest}`);
      out.add(`show ${rest}`);
    }
  }
  // template-prefixed phrasings — always include so vendor-named
  // queries ("show me my Slack team info") rank.
  if (!titleLower.startsWith(templateWords)) {
    out.add(`${templateWords} ${titleLower}`);
    out.add(`${templateWords} ${slugWords}`);
  }
  // verb-prefixed phrasings for noun-only titles ("Ping" → "check ping",
  // "Merchant info" → "show merchant info"). These give the LLM a
  // more conversational match path.
  if (!verbMatch) {
    out.add(`show ${titleLower}`);
    out.add(`get ${titleLower}`);
  }
  return Array.from(out);
}

function fixRecipe(recipe: Recipe, templateSlug: string): boolean {
  const original = recipe.intent_keywords ?? [];
  let kw = original.map(normalize).filter((k) => k.length > 0);

  // Drop single-word keywords already in the title.
  const titleWords = new Set(
    recipe.title
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0),
  );
  kw = kw.filter((k) => k.includes(" ") || !titleWords.has(k));

  // Dedupe.
  const dedup = new Set<string>();
  kw = kw.filter((k) => {
    if (dedup.has(k)) return false;
    dedup.add(k);
    return true;
  });

  // Backfill to ≥3.
  if (kw.length < 3) {
    for (const cand of deriveCandidates(recipe, templateSlug)) {
      const c = normalize(cand);
      if (c.length === 0) continue;
      if (dedup.has(c)) continue;
      // Skip single-word candidates that overlap the title.
      if (!c.includes(" ") && titleWords.has(c)) continue;
      dedup.add(c);
      kw.push(c);
      if (kw.length >= 3) break;
    }
  }

  // Cap at 7 by keeping the longest (most distinctive) entries.
  if (kw.length > 7) {
    kw.sort((a, b) => b.length - a.length);
    kw = kw.slice(0, 7);
  }

  // Stable order: original entries first (preserved order), then any
  // backfilled additions.
  const finalSet = new Set(kw);
  const ordered = [
    ...original.map(normalize).filter((k) => finalSet.has(k)),
    ...kw.filter((k) => !original.map(normalize).includes(k)),
  ];

  // Detect actual change.
  const before = JSON.stringify(original);
  const after = JSON.stringify(ordered);
  if (before === after) return false;

  recipe.intent_keywords = ordered;
  return true;
}

function main() {
  const raw = readFileSync(TEMPLATES_PATH, "utf8");
  const templates = JSON.parse(raw) as Template[];
  let fixed = 0;
  let scanned = 0;
  for (const t of templates) {
    for (const r of t.recipes ?? []) {
      scanned += 1;
      if (fixRecipe(r, t.slug)) fixed += 1;
    }
  }
  writeFileSync(TEMPLATES_PATH, `${JSON.stringify(templates, null, 2)}\n`, "utf8");
  console.log(`fixed intent_keywords on ${fixed}/${scanned} recipes`);
}

main();
