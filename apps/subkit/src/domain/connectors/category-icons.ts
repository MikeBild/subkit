export const CATEGORY_ICON: Readonly<Record<string, string>> = Object.freeze({
  http: "◆",
  graphql: "◈",
  postgres: "◯",
  s3: "□",
  sftp: "▥",
  mcp: "◇",
  webhook: "▶",
  local_files: "▤",
  local_browser: "◎",
  local_computer: "▣",
  default: "•",
});

export function categoryIconFor(category: string | null | undefined): string {
  const key = (category ?? "default").toLowerCase();
  return CATEGORY_ICON[key] ?? CATEGORY_ICON.default ?? "•";
}
