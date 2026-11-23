export type FtsConfig = "english" | "german";

export function ftsConfigFor(language: string | null | undefined): FtsConfig {
  return language === "de" ? "german" : "english";
}
