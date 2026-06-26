// Single canonical icon registry for connector categories.
//
// Both `IntegrationPicker.tsx` (the persona-facing fuzzy picker) and
// `repl/onboarding-wizard.tsx` (the guided template-pick step) used
// to keep their own copy of this map. Extracted here so a future
// category addition (or a glyph swap) lands in one place.

export const CATEGORY_ICON: Readonly<Record<string, string>> = Object.freeze({
  http: "◆",
  graphql: "◈",
  postgres: "◯",
  s3: "□",
  webhook: "▶",
  default: "•",
});

export function categoryIconFor(category: string | null | undefined): string {
  const key = (category ?? "default").toLowerCase();
  return CATEGORY_ICON[key] ?? CATEGORY_ICON.default ?? "•";
}
