import { envInt } from "../env.ts";
import type { BudgetState } from "./types.ts";

export const TOTAL_BUDGET_BYTES = envInt(
  "DOCS_INGESTION_MAX_BYTES_PER_CONNECTOR",
  10 * 1024 * 1024,
);
export const PER_PAGE_BYTES = envInt("DOCS_INGESTION_MAX_BYTES_PER_DOC", 3 * 1024 * 1024);
export const MAX_LINKS = envInt("DOCS_INGESTION_MAX_LINKS", 20);
const MAX_SPECS = envInt("DOCS_INGESTION_MAX_SPECS", 100);
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

export function recordBudgetWarning(state: BudgetState, message: string): void {
  if (!state.warnings) state.warnings = [];
  state.warnings.push(message);
}

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

export function assertPageSize(bytes: number): void {
  if (bytes > PER_PAGE_BYTES) throw new PageTooLargeError(bytes);
}

export function canFollowLink(state: BudgetState): boolean {
  return state.links_followed < MAX_LINKS;
}

export function recordLinkFollowed(state: BudgetState): void {
  state.links_followed += 1;
}

export function canFetchSpec(state: BudgetState): boolean {
  return state.specs_fetched < MAX_SPECS;
}

export function recordSpecFetched(state: BudgetState): void {
  state.specs_fetched += 1;
}
