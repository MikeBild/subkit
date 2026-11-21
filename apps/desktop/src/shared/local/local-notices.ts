export const POSTGRES_NOTICE_LIBRARIES = ["openssl", "icu", "libxml2", "lz4", "zstd"] as const;

const LICENSE_FILE = /^\d+-(LICENSE|COPYING|Copyright)(\.txt)?$/;

export interface NoticeText {
  path: string;
  text: string;
}

export function libraryOf(path: string): string | null {
  const match = /^dependency-notices\/([^/@]+)(@[^/]+)?\/([^/]+)$/.exec(path);
  if (!match || !LICENSE_FILE.test(match[3] ?? "")) return null;
  const name = match[1] ?? "";
  return name.startsWith("icu") ? "icu" : name;
}

export function postgresNoticePaths(files: string[]): string[] {
  return files
    .filter((path) => path === "COPYRIGHT" || path === "LICENSE" || libraryOf(path) !== null)
    .sort();
}

export function missingPostgresNotices(files: string[]): string[] {
  const kept = postgresNoticePaths(files);
  const missing: string[] = [];
  if (!kept.includes("COPYRIGHT")) missing.push("PostgreSQL COPYRIGHT");
  for (const library of POSTGRES_NOTICE_LIBRARIES)
    if (!kept.some((path) => libraryOf(path) === library)) missing.push(library);
  return missing;
}

export function renderPostgresNotices(version: string, texts: NoticeText[]): string {
  const sections = texts.map(({ path, text }) => {
    const title =
      path === "COPYRIGHT"
        ? "PostgreSQL License (COPYRIGHT)"
        : path === "LICENSE"
          ? "License of the PostgreSQL build (theseus-rs/postgresql-binaries)"
          : `${libraryOf(path)}: ${path}`;
    return `--- ${title} ---\n${text.trim()}\n`;
  });
  return [
    "",
    "LOCAL MODE: POSTGRESQL AND ITS LIBRARIES",
    `PostgreSQL ${version} as bundled in Resources/local/postgres, with the notices that come with the build.`,
    "",
    ...sections,
  ].join("\n");
}

export function renderEngineNotices(text: string): string {
  return [
    "",
    "LOCAL MODE: SUBKIT ENGINE (Resources/local/engine)",
    "The packages, runtime and models compiled into the bundled engine.",
    "",
    text.trim(),
    "",
  ].join("\n");
}
