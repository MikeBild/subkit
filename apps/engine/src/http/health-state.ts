// Module-scoped health state for the engine.
// Boot-time code (apps/engine/src/index.ts) writes here; the
// /v1/health route reads from it. Mirrors the `update-state.ts`
// pattern.

let _schemaDrift = false;

/**
 * Set by the boot path after `detectDrift(db)` returns. `true` means
 * the DB carries `drizzle.__drizzle_migrations` rows whose hash isn't
 * in this binary's embedded set — i.e. the schema state was set by a
 * different engine lineage. Surfaced in /v1/health so operators see
 * the alarm on the dashboard rather than scanning logs.
 */
export function setSchemaDriftFlag(value: boolean): void {
  _schemaDrift = value;
}

export function getSchemaDriftFlag(): boolean {
  return _schemaDrift;
}

/** Test-only reset. */
export function resetSchemaDriftFlag(): void {
  _schemaDrift = false;
}
