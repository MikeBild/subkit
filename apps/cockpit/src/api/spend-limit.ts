import type { components } from "@cli-core/engine-api/openapi";
import { apiCall } from "./call";

export type SpendLimit = components["schemas"]["SpendLimit"];

export const SPEND_LIMIT_KEY = ["spend-limit"] as const;

export function readSpendLimit(): Promise<SpendLimit> {
  return apiCall("get", "/v1/workspace/spend-limit", {});
}

export function writeSpendLimit(limit_usd: number): Promise<SpendLimit> {
  return apiCall("put", "/v1/workspace/spend-limit", { body: { limit_usd } });
}

export function continueSpend(): Promise<SpendLimit> {
  return apiCall("post", "/v1/workspace/spend-limit/continue", {});
}
