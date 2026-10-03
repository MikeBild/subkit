import type { QueryKey } from "@tanstack/react-query";

// The one table from an engine event to the Cockpit reads it makes stale.
//
// Keys are PREFIXES of the query keys the pages use (`["run", id]` is made
// stale by `["run"]`), so a new page reading under an existing key is covered
// without touching this file. A family maps to everything a reader sees change
// when it happens — a finished run changes the run list, the workflow's health
// on the catalogue, the Übersicht and the usage figures — and to nothing else.
//
// Step frames are the exception that keeps a long run cheap: a step finishing
// changes the open run sheet, not every list, so it refreshes the run's own
// reads only. The run's terminal frame refreshes the rest once.

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
  /** Matches an event type: an exact name, or a family ending in `.`. */
  prefix: string;
  keys: readonly QueryKey[];
}

/**
 * The table. The first rule whose prefix matches wins, so a narrower rule
 * (step frames) stands above its family. An event no rule names refreshes
 * nothing: an unknown type is a newer engine than this bundle, and guessing
 * would refresh everything on every frame.
 */
export const LIVE_RULES: readonly LiveRule[] = [
  { prefix: "execution.step.", keys: RUN_DETAIL },
  { prefix: "execution.", keys: [...RUN_DETAIL, ...RUN_LISTS] },
  // A schedule or hook held, released, paused or removed.
  { prefix: "workflow.automation_changed", keys: AUTOMATION },
  // Lifecycle, versions and execution authority granted or revoked.
  { prefix: "workflow.", keys: WORKFLOW },
  // Created, updated, deleted, credential changed, health, OAuth callbacks.
  { prefix: "connector.", keys: CONNECTOR },
  { prefix: "patch.", keys: [...DECISIONS, ["workflow"], ["catalog-detail"]] },
  { prefix: "skill.", keys: [...DECISIONS, ["catalog"], ["catalog-detail"]] },
];

function matches(rule: LiveRule, type: string): boolean {
  return rule.prefix.endsWith(".") ? type.startsWith(rule.prefix) : type === rule.prefix;
}

/** The query-key prefixes one event makes stale. */
export function keysForEvent(type: string): readonly QueryKey[] {
  return LIVE_RULES.find((rule) => matches(rule, type))?.keys ?? [];
}

/** A stable identity for a key prefix, to merge a burst of events into one refresh each. */
export function keyId(key: QueryKey): string {
  return JSON.stringify(key);
}
