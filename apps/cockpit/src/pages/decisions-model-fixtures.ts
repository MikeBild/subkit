import type { DecisionItem } from "./decisions-model";

export const NOW = Date.parse("2026-08-17T12:00:00.000Z");

export function daysAgo(days: number): string {
  return new Date(NOW - days * 86_400_000).toISOString();
}

export function item(
  kind: DecisionItem["kind"],
  days: number,
  id = `${kind}-${days}`,
  overrides: Partial<DecisionItem> = {},
): DecisionItem {
  return {
    kind,
    id,
    title: `${kind} ${days}`,
    target: null,
    origin: kind === "conversation" ? "conversation" : "observedFailure",
    waitingSince: daysAgo(days),
    classification: null,
    expiresAt: null,
    confidence: null,
    evidenceCount: null,
    summary: null,
    detail: { kind: "patch", evidence: PATCH_EVIDENCE },
    ...overrides,
  };
}

export const PATCH_EVIDENCE = {
  workflowId: null,
  workflowName: null,
  connectorId: null,
  endpointKey: null,
  executionId: null,
  environment: null,
  workflowStepId: null,
  gateCode: null,
  gateReason: null,
  gateStepId: null,
  fixer: null,
  driftKind: null,
  driftSummary: null,
  reasoning: null,
  proposalKind: null,
  classificationReasons: [],
  rejections: [],
};
