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

const KNOWLEDGE: QueryKey[] = [["catalog"], ["catalog-detail"], ["knowledge-source"]];

const FILES: QueryKey[] = [["catalog"], ["catalog-detail"], ["file"]];

const IDENTITY: QueryKey[] = [["admin"], ["audit-directory"]];

const RBAC: QueryKey[] = [["admin"]];

const API_KEYS: QueryKey[] = [["admin", "api-keys"]];

const SETTINGS: QueryKey[] = [["admin", "settings"]];

const AUDIT: QueryKey = ["audit"];

const STEP_PREFIX = "execution.step.";

export interface LiveRule {
  prefix: string;
  keys: readonly QueryKey[];
}

export const LIVE_RULES: readonly LiveRule[] = [
  { prefix: STEP_PREFIX, keys: RUN_DETAIL },
  { prefix: "execution.", keys: [...RUN_DETAIL, ...RUN_LISTS] },
  { prefix: "workflow.automation_changed", keys: AUTOMATION },
  { prefix: "workflow.", keys: WORKFLOW },
  { prefix: "connector.", keys: CONNECTOR },
  { prefix: "patch.", keys: [...DECISIONS, ["workflow"], ["catalog-detail"]] },
  { prefix: "skill.", keys: [...DECISIONS, ["catalog"], ["catalog-detail"]] },
  { prefix: "knowledge_source.", keys: KNOWLEDGE },
  { prefix: "file.", keys: FILES },
  { prefix: "identity.", keys: IDENTITY },
  { prefix: "rbac.", keys: RBAC },
  { prefix: "api_key.", keys: API_KEYS },
  { prefix: "settings.", keys: SETTINGS },
];

function matches(rule: LiveRule, type: string): boolean {
  return rule.prefix.endsWith(".") ? type.startsWith(rule.prefix) : type === rule.prefix;
}

export function keysForEvent(type: string): readonly QueryKey[] {
  const rule = LIVE_RULES.find((candidate) => matches(candidate, type));
  if (!rule) return [];
  return rule.prefix === STEP_PREFIX ? rule.keys : [...rule.keys, AUDIT];
}

export function keyId(key: QueryKey): string {
  return JSON.stringify(key);
}
