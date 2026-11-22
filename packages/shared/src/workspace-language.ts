export const WORKSPACE_LANGUAGES = ["de", "en"] as const;

export type WorkspaceLanguage = (typeof WORKSPACE_LANGUAGES)[number];

export const DEFAULT_WORKSPACE_LANGUAGE: WorkspaceLanguage = "en";

export function isWorkspaceLanguage(value: unknown): value is WorkspaceLanguage {
  return WORKSPACE_LANGUAGES.some((language) => language === value);
}

export function languageOf(value: unknown): WorkspaceLanguage | null {
  if (typeof value !== "string") return null;
  const tag = value.split(",")[0]?.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    WORKSPACE_LANGUAGES.find((language) => tag === language || tag.startsWith(`${language}-`)) ??
    null
  );
}

export function firstLanguage(preferences: readonly unknown[]): WorkspaceLanguage {
  for (const preference of preferences) {
    const language = languageOf(preference);
    if (language) return language;
  }
  return DEFAULT_WORKSPACE_LANGUAGE;
}
