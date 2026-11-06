import { definitionWithoutDescription } from "../canonical-json.ts";
import { buildStepDag, type CycleReport, detectCycles, renderCycleReport } from "../dag.ts";
import type { WorkflowDef } from "../types.ts";

export const SLUG_MAX_LENGTH = 64;
export const WORKFLOW_MAX_STEPS = 200;
export const AUTHORING_MAX_STEPS = 25;
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, SLUG_MAX_LENGTH);
}

export function workflowSlug(text: string, fallbackSuffix: string): string {
  return slugify(text) || `wf-${fallbackSuffix}`;
}

export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

export interface DefinitionIssue {
  path: string;
  message: string;
  rule_id: "workflow_cycle_detected";
}

export function stepCycles(def: Pick<WorkflowDef, "name" | "steps">): CycleReport {
  return detectCycles(buildStepDag(def as WorkflowDef));
}

export function cycleIssues(def: Pick<WorkflowDef, "name" | "steps">): DefinitionIssue[] {
  const found = stepCycles(def);
  const cycles = found.cycles.filter((cycle) => cycle.nodes.length > 1);
  if (cycles.length === 0) return [];
  const report = { has_cycle: true, cycles };
  return [
    {
      path: "steps",
      message: `workflow has a cyclic step dependency: ${renderCycleReport(report)}`,
      rule_id: "workflow_cycle_detected",
    },
  ];
}

export function gateIssue(error: string): { path: string; message: string } {
  const at = error.indexOf(": ");
  return at < 0
    ? { path: "", message: error }
    : { path: error.slice(0, at), message: error.slice(at + 2) };
}

export type StoredDefinitionRole = "version" | "draft";

export function toStoredDefinition<T>(def: T, role: StoredDefinitionRole): T {
  return role === "draft" ? def : definitionWithoutDescription(def);
}
