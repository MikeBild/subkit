import type { QueryKey } from "@tanstack/react-query";

const RUN_DETAIL: QueryKey[] = [["run"], ["run-steps"], ["run-cost"], ["execution"]];

const RUN_LISTS: QueryKey[] = [
  ["runs"],
  ["attention"],
  ["operations-figures"],
  ["operations-spend"],
  ["usage"],
  ["usage-status"],
  ["usage-workflow"],
  ["usage-llm"],
  ["workflow-recent-runs"],
  ["workflow-latest-failed-run"],
  ["workflow-diagnosis"],
  ["workflow-automation-status"],
  ["run-open-repair"],
  ["connector-stats"],
  ["catalog"],
  ["catalog-detail"],
];

const WORKFLOW: QueryKey[] = [
  ["workflow"],
  ["workflows"],
  ["workflow-draft-version"],
  ["workflow-authorities"],
  ["workflow-automation-status"],
  ["workflow-diagnosis"],
  ["workflow-schedule-holds"],
  ["workflow-grant-context"],
  ["workflow-invocation"],
  ["chat-automation-workflow"],
  ["catalog"],
  ["catalog-detail"],
  ["catalog-workflow-index"],
  ["admin", "workflows"],
  ["admin", "grants"],
  ["attention"],
  ["decisions"],
];

const CONNECTOR: QueryKey[] = [
  ["connector"],
  ["connectors"],
  ["connector-runtime"],
  ["connector-credential"],
  ["connector-stats"],
  ["connector-workflows"],
  ["catalog"],
  ["catalog-detail"],
  ["catalog-connector-index"],
  ["admin", "connectors"],
  ["admin", "connections"],
  ["attention"],
];

const DECISIONS: QueryKey[] = [
  ["decisions"],
  ["attention"],
  ["patch-candidate"],
  ["skill-candidate"],
  ["run-open-repair"],
  ["boundary-proposals"],
  ["admin", "prepared-changes"],
];

const AUTOMATION: QueryKey[] = [
  ["workflow-automation-status"],
  ["workflow-schedule-holds"],
  ["workflow"],
  ["catalog-detail"],
  ["decisions"],
  ["attention"],
];

export interface LiveRule {
  prefix: string;
  keys: readonly QueryKey[];
}

export const LIVE_RULES: readonly LiveRule[] = [
  { prefix: "execution.step.", keys: RUN_DETAIL },
  { prefix: "execution.", keys: [...RUN_DETAIL, ...RUN_LISTS] },
  { prefix: "workflow.automation_changed", keys: AUTOMATION },
  { prefix: "workflow.", keys: WORKFLOW },
  { prefix: "connector.", keys: CONNECTOR },
  { prefix: "patch.", keys: [...DECISIONS, ["workflow"], ["catalog-detail"]] },
  { prefix: "skill.", keys: [...DECISIONS, ["catalog"], ["catalog-detail"]] },
];

function matches(rule: LiveRule, type: string): boolean {
  return rule.prefix.endsWith(".") ? type.startsWith(rule.prefix) : type === rule.prefix;
}

export function keysForEvent(type: string): readonly QueryKey[] {
  return LIVE_RULES.find((rule) => matches(rule, type))?.keys ?? [];
}

export function keyId(key: QueryKey): string {
  return JSON.stringify(key);
}
