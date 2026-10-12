export interface LocalDatabaseEnvironment {
  [key: string]: string | undefined;
  DATABASE_URL?: string;
  SUBKIT_DB_PASSWORD?: string;
  SUBKIT_DB_PORT?: string;
}

const exampleUrls = new Set([
  "postgres://subkit:subkit@localhost:5432/subkit",
  "postgres://subkit:subkit-local-only@localhost:5432/subkit",
]);

export function localDatabaseUrl(env: LocalDatabaseEnvironment): string {
  const password = env.SUBKIT_DB_PASSWORD || "subkit-local-only";
  const port = env.SUBKIT_DB_PORT || "5432";
  if (!/^[A-Za-z0-9._~-]+$/.test(password)) {
    throw new Error("SUBKIT_DB_PASSWORD must use URL-unreserved characters only");
  }
  const configured = env.DATABASE_URL;
  if (configured && !exampleUrls.has(configured)) return configured;
  return `postgres://subkit:${encodeURIComponent(password)}@localhost:${port}/subkit`;
}
