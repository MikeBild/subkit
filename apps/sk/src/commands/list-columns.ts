// Column sets for the catalog list commands.
//
// Every entry must be a real property of the engine's corresponding list item.
// A name that does not exist does not fail — it renders as a permanently blank
// column, which is exactly what `status` did on `sk workflows list`: the engine
// has always called that field `lifecycle`, so the column was empty from the
// day it was added and stayed that way unnoticed.
//
// Kept in their own module (no imports) so `list-columns.test.ts` can check
// them against the committed OpenAPI schema without pulling the command
// modules — and with them the CLI's config/engine-client — into the test.

export const WORKFLOW_LIST_COLUMNS = [
  "id",
  "name",
  "lifecycle",
  "connectors",
  "runs_on",
  "updated_at",
];

/**
 * `runs_on` is synthesised from `effective_trigger` + `schedule`. It is
 * deliberately NOT called `trigger`: the item's `trigger` is only what the
 * definition declares, and reading it reported bound schedules as "request".
 */
export const WORKFLOW_SYNTHESISED_COLUMNS = ["runs_on"];

/**
 * `name` is the one deliberate exception to the "must exist on the item" rule:
 * the engine calls it `display_name`, and the command synthesises `name` from
 * it before rendering so the column is never blank.
 */
export const CONNECTOR_LIST_COLUMNS = ["id", "name", "slug", "environment", "template_slug"];

/** Columns the command fills in itself rather than reading off the API item. */
export const CONNECTOR_SYNTHESISED_COLUMNS = ["name"];
