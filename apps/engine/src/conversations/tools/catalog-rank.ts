export type RankField = "category" | "identity" | "description" | "detail";

const WEIGHTS: Record<RankField, { exact: number; variant: number }> = {
  category: { exact: 12, variant: 6 },
  identity: { exact: 9, variant: 5 },
  description: { exact: 4, variant: 2 },
  detail: { exact: 2, variant: 1 },
};

export const MIN_RANK_SCORE = 4;

function fold(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

const STOPWORDS = new Set(
  [
    "a an and are as at be by can do does for from has have how i in is it its me my of on or our please show that the their them there these this to us was we what when where which who why will with you your",
    "alle aller alles am an auch auf aus bei bin bis bitte das dass dem den der des die dies diese dieser dir doch du ein eine einem einen einer es für gib gibt hab habe haben hat ich ihr im in ist ja kann kannst mal mich mir mit nach nicht noch nur oder sie sind so über um und uns von vor was welche welcher welches wer wie wir wo zeig zeige zu zum zur",
    "workflow workflows connector connectors konnektor konnektoren skill skills quelle quellen source sources file files datei dateien list liste find finde",
  ]
    .join(" ")
    .split(/\s+/)
    .map(fold),
);

const SUFFIXES = ["ern", "en", "er", "es", "e", "s", "n"];

export function rankTokens(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

const variantCache = new Map<string, ReadonlySet<string>>();

function variantsOf(token: string): ReadonlySet<string> {
  const cached = variantCache.get(token);
  if (cached) return cached;
  const out = new Set<string>();
  for (const suffix of SUFFIXES) {
    if (token.length - suffix.length >= 4 && token.endsWith(suffix)) {
      out.add(token.slice(0, -suffix.length));
    }
  }
  if (token.length >= 8) out.add(token.slice(0, 5));
  if (variantCache.size > 50_000) variantCache.clear();
  variantCache.set(token, out);
  return out;
}

interface FieldIndex {
  field: RankField;
  tokens: Set<string>;
  variants: Set<string>;
}

function indexField(
  field: RankField,
  values: ReadonlyArray<string | null | undefined>,
): FieldIndex {
  const tokens = new Set<string>();
  const variants = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    for (const token of rankTokens(value)) {
      tokens.add(token);
      for (const v of variantsOf(token)) variants.add(v);
    }
  }
  return { field, tokens, variants };
}

function matchesVariant(term: string, index: FieldIndex): boolean {
  if (index.variants.has(term)) return true;
  for (const v of variantsOf(term)) {
    if (index.tokens.has(v) || index.variants.has(v)) return true;
  }
  if (term.length >= 4) {
    for (const token of index.tokens)
      if (token.length > term.length && token.startsWith(term)) return true;
  }
  return false;
}

export type RankFields = Partial<Record<RankField, ReadonlyArray<string | null | undefined>>>;

export interface RankReason {
  field: RankField;
  term: string;
  match: "exact" | "variant";
}

export interface Ranked<T> {
  item: T;
  score: number;
  reasons: RankReason[];
}

export function isListAllQuery(query: string | undefined): boolean {
  const trimmed = (query ?? "").trim().toLowerCase();
  return trimmed === "" || trimmed === "*" || trimmed === "all" || trimmed === "alle";
}

export function rankCatalog<T>(
  query: string,
  items: ReadonlyArray<T>,
  fieldsOf: (item: T) => RankFields,
): Ranked<T>[] {
  const terms = [...new Set(rankTokens(query))];
  if (terms.length === 0) return [];
  const ranked: Array<Ranked<T> & { order: number }> = [];
  items.forEach((item, order) => {
    const fields = fieldsOf(item);
    const indexes = (Object.keys(WEIGHTS) as RankField[])
      .filter((f) => fields[f] !== undefined)
      .map((f) => indexField(f, fields[f] ?? []));
    let score = 0;
    const reasons: RankReason[] = [];
    for (const term of terms) {
      let best: RankReason | null = null;
      let bestScore = 0;
      for (const index of indexes) {
        const weight = WEIGHTS[index.field];
        if (index.tokens.has(term) && weight.exact > bestScore) {
          best = { field: index.field, term, match: "exact" };
          bestScore = weight.exact;
        } else if (weight.variant > bestScore && matchesVariant(term, index)) {
          best = { field: index.field, term, match: "variant" };
          bestScore = weight.variant;
        }
      }
      if (best) {
        score += bestScore;
        reasons.push(best);
      }
    }
    if (score >= MIN_RANK_SCORE) ranked.push({ item, score, reasons, order });
  });
  ranked.sort((a, b) => b.score - a.score || a.order - b.order);
  return ranked.map(({ order: _order, ...rest }) => rest);
}

export interface RankedPage<T> {
  matches: Array<T | (T & { reasons: string[] })>;
  total: number;
  truncated?: true;
  hint?: string;
}

export function rankedPage<T>(
  query: string | undefined,
  items: ReadonlyArray<T>,
  fieldsOf: (item: T) => RankFields,
  limit: number,
  listTool: string,
): RankedPage<T> {
  if (isListAllQuery(query)) {
    const page = items.slice(0, limit);
    return {
      matches: page,
      total: items.length,
      ...(items.length > page.length ? { truncated: true as const } : {}),
    };
  }
  const ranked = rankCatalog(query ?? "", items, fieldsOf);
  if (ranked.length === 0) {
    return {
      matches: [],
      total: 0,
      hint: `Nothing matches "${query}". Try fewer or different words, or call ${listTool} with a \`category\` to browse one catalog block.`,
    };
  }
  const page = ranked.slice(0, limit);
  return {
    matches: page.map((r) => ({
      ...r.item,
      reasons: r.reasons.map((reason) => `${reason.field}:${reason.term}`),
    })),
    total: ranked.length,
    ...(ranked.length > page.length ? { truncated: true as const } : {}),
  };
}
