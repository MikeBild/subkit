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
  ["workflow-active-run"],
  ["schedule-occurrences"],
  ["run-open-repair"],
  ["connector-stats"],
  ["catalog"],
  ["catalog-detail"],
];

const WORKFLOW: QueryKey[] = [
  ["workflow"],
  ["schedule-occurrences"],
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
  ["admin", "apps"],
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
  ["schedule-occurrences"],
  ["catalog-detail"],
  ["decisions"],
  ["attention"],
];

const TASK: QueryKey[] = [
  ["tasks"],
  ["task"],
  ["schedule-occurrences"],
  ["task-grants"],
  ["attention"],
];

const TASK_GRANT: QueryKey[] = [
  ...TASK,
  ["decisions"],
  ["workflow-authorities"],
  ["workflow-automation-status"],
];

const TASK_RUN: QueryKey[] = [
  ["tasks"],
  ["task"],
  ["schedule-occurrences"],
  ["task-runs"],
  ["task-run"],
  ["task-run-playbook"],
  ["task-usage"],
  ["task-grants"],
  ["attention"],
];

const KNOWLEDGE: QueryKey[] = [["catalog"], ["catalog-detail"], ["knowledge-source"]];

const FILES: QueryKey[] = [["catalog"], ["catalog-detail"], ["file"]];

const IDENTITY: QueryKey[] = [["admin"], ["audit-directory"]];

const RBAC: QueryKey[] = [["admin"]];

const API_KEYS: QueryKey[] = [["admin", "api-keys"]];

const SETTINGS: QueryKey[] = [
  ["admin", "settings"],
  ["admin", "apps"],
];

const AUDIT: QueryKey = ["audit"];

const STEP_PREFIX = "execution.step.";

interface LiveRule {
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
  { prefix: "task.grant_changed", keys: TASK_GRANT },
  { prefix: "task.", keys: TASK },
  { prefix: "task_run.", keys: TASK_RUN },
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
