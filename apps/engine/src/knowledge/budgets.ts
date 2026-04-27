// Knowledge Sources budgets — per-source and per-tenant limits.
// Reuses the guard pattern from docs-ingestion/budgets.ts.

import { envIntOr } from "../utils/env-config.ts";

/** Maximum bytes for a single knowledge source upload. */
export const KNOWLEDGE_SOURCE_MAX_BYTES = envIntOr("KNOWLEDGE_SOURCE_MAX_BYTES", 50 * 1024 * 1024);

/** Maximum total knowledge bytes per tenant across all sources. */
export const KNOWLEDGE_TENANT_MAX_BYTES = envIntOr("KNOWLEDGE_TENANT_MAX_BYTES", 500 * 1024 * 1024);

/** Maximum number of files attached in a single conversation message. */
export const MAX_FILES_PER_MESSAGE = envIntOr("KNOWLEDGE_MAX_FILES_PER_MESSAGE", 10);

export class KnowledgeBudgetExceededError extends Error {
  readonly bytes_used: number;
  readonly bytes_limit: number;
  constructor(message: string, bytes_used: number, bytes_limit: number) {
    super(message);
    this.name = "KnowledgeBudgetExceededError";
    this.bytes_used = bytes_used;
    this.bytes_limit = bytes_limit;
  }
}
