export interface BootFailure {
  phase: string;
  cause: string;
  next: string;
}

const BY_CAUSE: ReadonlyArray<[RegExp, string]> = [
  [/EADDRINUSE|address already in use/i, "Free the port or set PORT to a free one, then restart."],
  [
    /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|connect ETIMEDOUT|the database system is starting up/i,
    "Start PostgreSQL and check that DATABASE_URL points to it, then restart.",
  ],
  [
    /password authentication failed|role .* does not exist|no pg_hba\.conf entry/i,
    "Check the user and password in DATABASE_URL, then restart.",
  ],
  [/database .* does not exist/i, "Create the database named in DATABASE_URL, then restart."],
  [
    /MASTER_KEY|master key|vault/i,
    "Set MASTER_KEY to the 64 hex characters this database was created with.",
  ],
  [
    /EACCES|EPERM|EROFS|permission denied|read-only file system/i,
    "Give the engine write access to the folder named in the error, then restart.",
  ],
  [/ENOSPC|no space left/i, "Free up disk space, then restart."],
];

const BY_PHASE: Readonly<Record<string, string>> = {
  config_load: "Fix the setting named in the error (environment or config file), then restart.",
  crypto_assert: "Set MASTER_KEY to 64 hex characters, then restart.",
  preflight: "Fix the preflight check named in the error, then restart.",
  migrations: "Run the engine with --migrate to see the failing migration, fix it, then restart.",
  search_path: "Reset the search_path of the database role to the default, then restart.",
  runtime_config: "Check the runtime settings named in the error, then restart.",
  boot_dependencies: "Fix the dependency named in the error, then restart.",
  queue_start: "Check that the database user may create the pgboss schema, then restart.",
  queue_handlers: "Restart the engine; report the error if it repeats.",
  listen: "Free the port or set PORT to a free one, then restart.",
};

const FALLBACK = "Restart the engine; report the error with its trace_id if it repeats.";

export function bootFailure(phase: string | null, cause: string): BootFailure {
  const known = phase ?? "unknown";
  const byCause = BY_CAUSE.find(([pattern]) => pattern.test(cause))?.[1];
  return { phase: known, cause, next: byCause ?? BY_PHASE[known] ?? FALLBACK };
}
