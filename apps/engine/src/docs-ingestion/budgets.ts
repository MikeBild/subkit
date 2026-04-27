// Budget guards for documentation ingestion.
//
// Canonical caps (from docs/04-authoring.md):
//   - total 10 MB per connector per ingest run
//   - per-page (single fetched document / chunk) 3 MB
//   - 20 links followed from llms.txt / markdown
//   - 25 concurrent openapi fetches (used by the semaphore in the service)
//   - 100 specs per ingestion run
//
// Every guard is a plain function that mutates the shared `BudgetState`
// and reports whether the run should keep going. No throwing inside the
// guards — the orchestrator inspects `state.budget_exceeded` and stops
// cleanly so partial writes are preserved.

import { envIntOr } from "../utils/env-config.ts";
import type { BudgetState } from "./types.ts";

// Operator-tunable via env vars. Defaults match the canonical caps in
// docs/04-authoring.md; ops can raise them per deployment without a rebuild.
export const TOTAL_BUDGET_BYTES = envIntOr(
  "DOCS_INGESTION_MAX_BYTES_PER_CONNECTOR",
  10 * 1024 * 1024,
);
export const PER_PAGE_BYTES = envIntOr("DOCS_INGESTION_MAX_BYTES_PER_DOC", 3 * 1024 * 1024);
export const MAX_LINKS = envIntOr("DOCS_INGESTION_MAX_LINKS", 20);
export const MAX_CONCURRENT_OPENAPI = envIntOr("DOCS_INGESTION_MAX_CONCURRENT", 25);
export const MAX_SPECS = envIntOr("DOCS_INGESTION_MAX_SPECS", 100);
export const DEDUP_THRESHOLD = 0.9;

export function createBudgetState(): BudgetState {
  return {
    bytes_used: 0,
    links_followed: 0,
    specs_fetched: 0,
    budget_exceeded: false,
    warnings: [],
  };
}

/** Append a soft warning to the budget state's warning bag. */
export function recordBudgetWarning(state: BudgetState, message: string): void {
  if (!state.warnings) state.warnings = [];
  state.warnings.push(message);
}

/** Returns true if the next `bytes` would stay under the total cap. */
export function canConsumeBytes(state: BudgetState, bytes: number): boolean {
  if (state.budget_exceeded) return false;
  return state.bytes_used + bytes <= TOTAL_BUDGET_BYTES;
}

export function consumeBytes(state: BudgetState, bytes: number): void {
  state.bytes_used += bytes;
  if (state.bytes_used >= TOTAL_BUDGET_BYTES) {
    state.budget_exceeded = true;
  }
}

export function markBudgetExceeded(state: BudgetState): void {
  state.budget_exceeded = true;
}

export class PageTooLargeError extends Error {
  readonly bytes: number;
  constructor(bytes: number) {
    super(`page exceeds per-page budget of ${PER_PAGE_BYTES} bytes (got ${bytes})`);
    this.bytes = bytes;
    this.name = "PageTooLargeError";
  }
}

/** Throws `PageTooLargeError` when a single fetched page > 3 MB. */
export function assertPageSize(bytes: number): void {
  if (bytes > PER_PAGE_BYTES) throw new PageTooLargeError(bytes);
}

/** Returns true if one more link can be followed (≤ 20). */
export function canFollowLink(state: BudgetState): boolean {
  return state.links_followed < MAX_LINKS;
}

export function recordLinkFollowed(state: BudgetState): void {
  state.links_followed += 1;
}

/** Returns true if one more spec can be fetched (≤ 100). */
export function canFetchSpec(state: BudgetState): boolean {
  return state.specs_fetched < MAX_SPECS;
}

export function recordSpecFetched(state: BudgetState): void {
  state.specs_fetched += 1;
}

/**
 * Simple semaphore — used to cap concurrent openapi fetches at 25. The
 * caller `acquire()`s before the fetch and `release()`s in a finally.
 */
export class Semaphore {
  private remaining: number;
  private waiters: Array<() => void> = [];
  constructor(limit: number) {
    this.remaining = limit;
  }
  async acquire(): Promise<void> {
    if (this.remaining > 0) {
      this.remaining -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.remaining -= 1;
  }
  release(): void {
    this.remaining += 1;
    const next = this.waiters.shift();
    if (next) next();
  }
}
